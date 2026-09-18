// -*- coding: utf-8 -*-
// أكتور Apify لاستخراج إعلانات وصلت (wasalt.sa) عبر التصفح المباشر

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
        // مسار 1: صفحة البحث — جمع روابط الإعلانات
        // ==========================================
        if (request.userData.label === 'SEARCH') {

            const searchUrl = `https://wasalt.sa/ar/${listingType}/search?cityId=${cityId}&countryId=1&propertyFor=${listingType}&type=${propertyType}`;
            reqLog.info(`فتح صفحة البحث: ${searchUrl}`);

            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            try {
                await page.waitForSelector('a[href*="/property/"], a[href*="/sale/"], a[href*="/rent/"]', { timeout: 15000 });
            } catch {
                reqLog.warning('لم تظهر بطاقات العقارات، سيتم المتابعة...');
            }
            await page.waitForTimeout(2000);

            let collectedUrls = new Set();
            let previousCount = 0;
            let staleRounds = 0;

            while (collectedUrls.size < maxResults && staleRounds < 6) {

                const pageUrls = await page.evaluate(() => {
                    const anchors = Array.from(document.querySelectorAll('a[href]'));
                    return anchors
                        .map(a => a.href)
                        .filter(href =>
                            href.includes('wasalt.sa') &&
                            href.match(/wasalt\.sa\/(ar|en|property)\/(sale|rent|property)\/[^?#]+\d+/)
                        );
                });

                pageUrls.forEach(u => collectedUrls.add(u));

                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 4));
                await page.waitForTimeout(2500);

                if (collectedUrls.size === previousCount) {
                    staleRounds++;
                } else {
                    staleRounds = 0;
                }
                previousCount = collectedUrls.size;
                reqLog.info(`تم جمع ${collectedUrls.size} رابط حتى الآن...`);
            }

            const urlsArray = Array.from(collectedUrls).slice(0, maxResults);
            reqLog.info(`✅ إجمالي الروابط: ${urlsArray.length}`);

            for (const url of urlsArray) {
                await crawler.addRequests([{ url, userData: { label: 'DETAIL' } }]);
            }

        // ==========================================
        // مسار 2: صفحة التفاصيل — استخراج بيانات العقار
        // ==========================================
        } else if (request.userData.label === 'DETAIL') {

            reqLog.info(`فتح تفاصيل: ${request.url}`);

            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(2000);

            const nextDataText = await page.evaluate(() => {
                const el = document.querySelector('#__NEXT_DATA__');
                return el ? el.textContent : null;
            });

            let item = {
                name: '',
                phone: '',
                priceSar: '',
                city: city,
                district: '',
                address: '',
                area_sqm: '',
                bedrooms: '',
                bathrooms: '',
                owner_name: '',
                is_verified: false,
                posted_at: '',
                posted_at_iso: '',
                updated_at: '',
                has_image: false,
                images: [],
                url: request.url,
                source: 'wasalt',
                _raw_id: '',
            };

            if (nextDataText) {
                try {
                    const data = JSON.parse(nextDataText);

                    let propObj = null;

                    const findProp = (obj, depth = 0) => {
                        if (depth > 15 || propObj || !obj || typeof obj !== 'object') return;
                        if (obj.property_info && obj.id && obj.property_files) {
                            propObj = obj;
                            return;
                        }
                        if (obj.property_info && obj.id && !propObj) {
                            propObj = obj;
                        }
                        for (const val of Object.values(obj)) {
                            findProp(val, depth + 1);
                        }
                    };
                    findProp(data);

                    if (propObj) {
                        const info  = propObj.property_info  || {};
                        const owner = propObj.property_owner || {};
                        const rega  = propObj.rega_raw_info  || {};
                        const files = propObj.property_files || {};

                        item._raw_id     = String(propObj.id || '');
                        item.name        = info.title || info.property_name || info.slug || '';
                        item.priceSar    = String(info.sale_price || info.conversion_price || info.expected_rent || '');
                        item.city        = info.city    || city;
                        item.district    = info.zone    || info.district || '';
                        item.address     = info.address || '';
                        item.is_verified = !!(propObj.is_verified || propObj.is_rega_prop);
                        item.area_sqm    = String(propObj.floor_size || rega.property_area || '');
                        item.owner_name  = owner.ar_name || owner.name || '';

                        const attrs = propObj.attributes || [];
                        for (const attr of attrs) {
                            if (attr.key === 'noOfBedrooms')  item.bedrooms  = String(attr.value || '');
                            if (attr.key === 'noOfBathrooms') item.bathrooms = String(attr.value || '');
                            if (attr.key === 'builtUpArea' && !item.area_sqm) item.area_sqm = String(attr.value || '');
                        }

                        item.phone = rega.phone_number
                            || rega.responsible_employee_phone_number
                            || owner.mobile
                            || owner.phone
                            || propObj.contact_number
                            || '';

                        const imgs = files.images || [];
                        item.images = imgs.map(img =>
                            img.startsWith('http') ? img
                            : `https://assets.wasalt.com/properties/${propObj.id}/images/${img}`
                        );
                        item.has_image = item.images.length > 0;

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
                                item.posted_at_iso = d.toISOString();
                                item.posted_at = d.toLocaleString('ar-SA', {
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
                                item.updated_at = d.toLocaleString('ar-SA', {
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

            // Fallback من DOM
            if (!item.name) {
                item.name = await page.evaluate(() =>
                    document.querySelector('h1')?.innerText?.trim() || ''
                );
            }
            if (!item.priceSar) {
                item.priceSar = await page.evaluate(() => {
                    const el = document.querySelector('[class*="price"], [class*="Price"]');
                    return el?.innerText?.replace(/[^\d]/g, '') || '';
                });
            }
            if (!item.phone) {
                item.phone = await page.evaluate(() => {
                    const el = document.querySelector('a[href^="tel:"]');
                    return el ? el.href.replace('tel:', '').trim() : '';
                });
            }

            if (!item.name && !item.priceSar) {
                reqLog.warning(`⚠️ تجاهل إعلان فارغ: ${request.url}`);
                return;
            }
            if (item._raw_id && seenIds.has(item._raw_id)) {
                reqLog.info(`⚠️ تجاهل مكرر: ${item._raw_id}`);
                return;
            }
            if (item._raw_id) seenIds.add(item._raw_id);

            finalItems.push(item);
            await Actor.pushData(item);
            reqLog.info(`✅ ${item.name} | ${item.priceSar} ريال | ${item.phone || 'لا يوجد جوال'} | ${item.posted_at || 'لا يوجد تاريخ'}`);
        }
    },

    async failedRequestHandler({ request }, error) {
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
