// -*- coding: utf-8 -*-
// أكتور Apify لاستخراج إعلانات وصلت (wasalt.sa)
// الاستراتيجية: استخراج معظم البيانات من صفحة البحث مباشرةً، ثم فتح صفحة التفاصيل فقط لجلب الجوال والتاريخ

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    city = 'الرياض',
    cityId = 273,
    listingType = 'sale',
    propertyType = 'residential',
    maxResults = 20,
    proxyConfiguration: proxyInput,
    webhookUrl = '',
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration(
    proxyInput || { useApifyProxy: true, groups: ['RESIDENTIAL'] },
);

const finalItems = [];
const seenIds = new Set();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 2,
    maxRequestsPerCrawl: maxResults + 50,
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 60,

    async requestHandler({ page, request, log: reqLog }) {

        // ==========================================
        // مسار 1: صفحة البحث — استخراج البيانات الأساسية من الـ HTML مباشرة
        // ==========================================
        if (request.userData.label === 'SEARCH') {

            const searchUrl = `https://wasalt.sa/ar/${listingType}/search?cityId=${cityId}&countryId=1&propertyFor=${listingType}&type=${propertyType}`;
            reqLog.info(`فتح صفحة البحث: ${searchUrl}`);

            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            try {
                await page.waitForSelector('a[href*="/property/"]', { timeout: 15000 });
            } catch {
                reqLog.warning('لم تظهر بطاقات العقارات، سيتم المتابعة...');
            }
            await page.waitForTimeout(2000);

            let totalCollected = 0;
            let staleRounds = 0;

            while (totalCollected < maxResults && staleRounds < 5) {

                const cards = await page.evaluate((listingType) => {
                    const results = [];
                    const links = Array.from(document.querySelectorAll('a[href*="/property/"]'));

                    const seen = new Set();
                    for (const link of links) {
                        const href = link.href;
                        const idMatch = href.match(/-(\d+)$/);
                        if (!idMatch) continue;
                        const id = idMatch[1];
                        if (seen.has(id)) continue;
                        seen.add(id);

                        const card = link.closest('div[class*="card"], div[class*="property"], div[class*="listing"], article, li') || link.parentElement?.parentElement;

                        const cardText = card?.innerText || '';
                        const priceMatch = cardText.match(/([\d,]+)\s*(ريال|ر\.س|SAR)?/);
                        const price = priceMatch ? priceMatch[1].replace(/,/g, '') : '';

                        const name = link.getAttribute('title') || link.innerText?.trim() || '';

                        const addressEl = card?.querySelector('[class*="zone"], [class*="district"], [class*="address"], [class*="location"]');
                        const address = addressEl?.innerText?.trim() || '';

                        const imgEl = card?.querySelector('img');
                        const imgSrc = imgEl?.src || imgEl?.getAttribute('data-src') || '';

                        results.push({
                            _raw_id: id,
                            name: name.replace(/\n.*/s, '').trim(),
                            priceSar: price,
                            address: address,
                            has_image: !!imgSrc,
                            images: imgSrc ? [imgSrc] : [],
                            url: href,
                        });
                    }
                    return results;
                }, listingType);

                let newCount = 0;
                for (const card of cards) {
                    if (seenIds.has(card._raw_id)) continue;
                    if (finalItems.length >= maxResults) break;
                    seenIds.add(card._raw_id);

                    card.city = city;
                    card.district = '';
                    card.area_sqm = '';
                    card.bedrooms = '';
                    card.bathrooms = '';
                    card.listing_type = listingType;
                    card.source = 'wasalt';
                    card.phone = '';
                    card.owner_name = '';
                    card.is_verified = false;
                    card.posted_at = '';
                    card.posted_at_iso = '';
                    card.updated_at = '';
                    card.scanned_at = new Date().toISOString();

                    if (card.address) {
                        const parts = card.address.split('،');
                        card.district = parts[0]?.trim() || '';
                        card.city = parts[parts.length - 1]?.trim() || city;
                    }

                    finalItems.push(card);
                    newCount++;
                }

                totalCollected = finalItems.length;
                reqLog.info(`تم جمع ${totalCollected} إعلان حتى الآن...`);

                if (newCount === 0) {
                    staleRounds++;
                } else {
                    staleRounds = 0;
                    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 4));
                    await page.waitForTimeout(2500);
                }
            }

            reqLog.info(`✅ انتهى جمع ${finalItems.length} إعلان من صفحة البحث`);

            for (const item of finalItems) {
                await crawler.addRequests([{
                    url: item.url,
                    userData: { label: 'DETAIL', rawId: item._raw_id },
                }]);
            }

        // ==========================================
        // مسار 2: صفحة التفاصيل — جلب الجوال والتاريخ فقط
        // ==========================================
        } else if (request.userData.label === 'DETAIL') {

            const rawId = request.userData.rawId;
            reqLog.info(`جلب تفاصيل العقار ${rawId}: ${request.url}`);

            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(1500);

            const nextDataText = await page.evaluate(() => {
                const el = document.querySelector('#__NEXT_DATA__');
                return el ? el.textContent : null;
            });

            let phone = '';
            let posted_at = '';
            let posted_at_iso = '';
            let updated_at = '';
            let bedrooms = '';
            let bathrooms = '';
            let area_sqm = '';
            let district = '';
            let owner_name = '';
            let is_verified = false;

            if (nextDataText) {
                try {
                    const data = JSON.parse(nextDataText);

                    let propObj = null;
                    const findProp = (obj, depth = 0) => {
                        if (depth > 15 || propObj || !obj || typeof obj !== 'object') return;
                        if (obj.property_info && obj.id) { propObj = obj; return; }
                        for (const val of Object.values(obj)) findProp(val, depth + 1);
                    };
                    findProp(data);

                    if (propObj) {
                        const info  = propObj.property_info  || {};
                        const owner = propObj.property_owner || {};
                        const rega  = propObj.rega_raw_info  || {};

                        phone = rega.phone_number
                            || rega.responsible_employee_phone_number
                            || owner.mobile || owner.phone || '';

                        owner_name  = owner.ar_name || owner.name || '';
                        is_verified = !!(propObj.is_verified || propObj.is_rega_prop);
                        area_sqm    = String(propObj.floor_size || rega.property_area || '');
                        district    = info.zone || info.district || '';

                        const attrs = propObj.attributes || [];
                        for (const attr of attrs) {
                            if (attr.key === 'noOfBedrooms')  bedrooms  = String(attr.value || '');
                            if (attr.key === 'noOfBathrooms') bathrooms = String(attr.value || '');
                            if (attr.key === 'builtUpArea' && !area_sqm) area_sqm = String(attr.value || '');
                        }

                        const rawPosted = propObj.published_at || propObj.created_at || rega.creation_date || '';
                        if (rawPosted) {
                            let d;
                            if (typeof rawPosted === 'string' && rawPosted.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
                                const [dd, mm, yyyy] = rawPosted.split('/');
                                d = new Date(`${yyyy}-${mm}-${dd}`);
                            } else {
                                d = new Date(rawPosted);
                            }
                            if (!isNaN(d.getTime())) {
                                posted_at_iso = d.toISOString();
                                posted_at = d.toLocaleString('ar-SA', {
                                    timeZone: 'Asia/Riyadh',
                                    year: 'numeric', month: '2-digit', day: '2-digit',
                                    hour: '2-digit', minute: '2-digit',
                                });
                            }
                        }

                        const rawUpdated = propObj.updated_at || '';
                        if (rawUpdated) {
                            const d = new Date(rawUpdated);
                            if (!isNaN(d.getTime())) {
                                updated_at = d.toLocaleString('ar-SA', {
                                    timeZone: 'Asia/Riyadh',
                                    year: 'numeric', month: '2-digit', day: '2-digit',
                                    hour: '2-digit', minute: '2-digit',
                                });
                            }
                        }
                    }
                } catch (e) {
                    reqLog.warning(`فشل تحليل __NEXT_DATA__: ${e.message}`);
                }
            }

            if (!phone) {
                phone = await page.evaluate(() => {
                    const el = document.querySelector('a[href^="tel:"]');
                    return el ? el.href.replace('tel:', '').trim() : '';
                });
            }

            const idx = finalItems.findIndex(i => i._raw_id === rawId);
            if (idx !== -1) {
                finalItems[idx].phone         = phone;
                finalItems[idx].posted_at     = posted_at;
                finalItems[idx].posted_at_iso = posted_at_iso;
                finalItems[idx].updated_at    = updated_at;
                finalItems[idx].bedrooms      = bedrooms  || finalItems[idx].bedrooms;
                finalItems[idx].bathrooms     = bathrooms || finalItems[idx].bathrooms;
                finalItems[idx].area_sqm      = area_sqm  || finalItems[idx].area_sqm;
                finalItems[idx].district      = district  || finalItems[idx].district;
                finalItems[idx].owner_name    = owner_name;
                finalItems[idx].is_verified   = is_verified;

                await Actor.pushData(finalItems[idx]);
                reqLog.info(`✅ ${finalItems[idx].name} | ${finalItems[idx].priceSar} ريال | ${phone || 'لا جوال'} | ${posted_at || 'لا تاريخ'}`);
            }
        }
    },

    async failedRequestHandler({ request }, error) {
        if (request.userData.label === 'DETAIL') {
            const rawId = request.userData.rawId;
            const idx = finalItems.findIndex(i => i._raw_id === rawId);
            if (idx !== -1 && !finalItems[idx]._saved) {
                finalItems[idx]._saved = true;
                await Actor.pushData(finalItems[idx]);
            }
        }
        log.error(`❌ فشل: ${request.url} — ${error.message}`);
    },
});

await crawler.run([{
    url: `https://wasalt.sa/ar/${listingType}/search?cityId=${cityId}&countryId=1&propertyFor=${listingType}&type=${propertyType}`,
    userData: { label: 'SEARCH' },
}]);

log.info(`🎉 اكتمل! تم استخراج ${finalItems.length} عقار.`);

if (webhookUrl && webhookUrl.trim()) {
    try {
        const datasetId = process.env.APIFY_DEFAULT_DATASET_ID;
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: 'success',
                city,
                itemsCount: finalItems.length,
                downloadUrl: `https://api.apify.com/v2/datasets/${datasetId}/items?format=json`,
            }),
        });
        log.info('✅ Webhook أُرسل بنجاح.');
    } catch (err) {
        log.error(`❌ فشل Webhook: ${err.message}`);
    }
}

await Actor.exit();
