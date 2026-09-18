// -*- coding: utf-8 -*-
// أكتور Apify مخصّص لاستخراج إعلانات وصلت العقارية (wasalt.sa).

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    search = '',
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

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 3,
    maxRequestsPerCrawl: maxResults + 30,
    requestHandlerTimeoutSecs: 90,
    navigationTimeoutSecs: 60,
    async requestHandler({ page, request, log: reqLog }) {

        // حظر الموارد الثقيلة لتوفير استهلاك البروكسي
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        // ==========================================
        // مسار 1: استخراج تفاصيل العقار من الداخل
        // ==========================================
        if (request.userData.label === 'DETAIL') {
            reqLog.info(`استخراج تفاصيل العقار: ${request.url}`);
            await page.goto(request.url, { waitUntil: 'domcontentloaded' });

            // جلب البيانات من __NEXT_DATA__
            const nextDataText = await page.evaluate(() => {
                const script = document.querySelector('#__NEXT_DATA__');
                return script ? script.innerText : null;
            });

            let item = {
                title: '',
                price_sar: '',
                property_type: '',
                listing_type: listingType,
                city: city,
                district: '',
                address: '',
                area_sqm: '',
                bedrooms: '',
                bathrooms: '',
                phone: '',
                owner_name: '',
                owner_type: '',
                rega_license: '',
                is_verified: false,
                posted_at: '',
                posted_at_iso: '',
                updated_at: '',
                description: '',
                has_image: false,
                images: [],
                url: request.url,
                source: 'wasalt',
                _raw_id: '',
            };

            if (nextDataText) {
                try {
                    const data = JSON.parse(nextDataText);

                    // البحث عن كائن العقار داخل بيانات Next.js
                    let propObj = null;
                    JSON.stringify(data, (key, value) => {
                        if (value && typeof value === 'object' && value.property_info && value.id) {
                            propObj = value;
                        }
                        return value;
                    });

                    if (propObj) {
                        const info = propObj.property_info || {};
                        const owner = propObj.property_owner || propObj.lead_contact_info || {};
                        const regaInfo = propObj.rega_raw_info || {};

                        item._raw_id = String(propObj.id || '');
                        item.title = info.title || info.property_name || '';
                        item.price_sar = String(info.sale_price || info.conversion_price || '');
                        item.property_type = info.property_sub_type || info.property_main_type || '';
                        item.listing_type = info.property_for || listingType;
                        item.city = info.city || city;
                        item.district = info.zone || info.district || '';
                        item.address = info.address || '';
                        item.area_sqm = propObj.floor_size || '';
                        item.is_verified = propObj.is_verified || propObj.is_rega_prop || false;
                        item.description = propObj.rega_moj_desc || '';

                        // استخراج الغرف والحمامات من الـ attributes
                        const attrs = propObj.attributes || [];
                        for (const attr of attrs) {
                            if (attr.key === 'noOfBedrooms') item.bedrooms = String(attr.value || '');
                            if (attr.key === 'noOfBathrooms') item.bathrooms = String(attr.value || '');
                            if (attr.key === 'builtUpArea') item.area_sqm = item.area_sqm || String(attr.value || '');
                        }

                        // بيانات المالك والتواصل
                        item.owner_name = owner.ar_name || owner.name || owner.owner_name || '';
                        item.owner_type = owner.ar_user_role || owner.en_user_role || '';
                        item.rega_license = owner.rega_adv_lic_no || regaInfo.ad_license_number || '';

                        // رقم الجوال (من REGA أو المالك)
                        item.phone = regaInfo.phone_number
                            || regaInfo.responsible_employee_phone_number
                            || '';

                        // الصور
                        const files = propObj.property_files || {};
                        const imgs = files.images || [];
                        item.images = imgs.map(img =>
                            img.startsWith('http') ? img :
                            `https://assets.wasalt.com/properties/${propObj.id}/images/${img}`
                        );
                        item.has_image = item.images.length > 0;

                        // وقت النشر
                        const rawDate = propObj.published_at || propObj.created_at || '';
                        if (rawDate) {
                            const d = new Date(rawDate);
                            if (!isNaN(d.getTime())) {
                                item.posted_at_iso = d.toISOString();
                                item.posted_at = d.toLocaleString('ar-SA', {
                                    timeZone: 'Asia/Riyadh',
                                    year: 'numeric', month: '2-digit', day: '2-digit',
                                    hour: '2-digit', minute: '2-digit',
                                });
                            }
                        }

                        // وقت التحديث
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
                    reqLog.warning(`فشل تحليل بيانات Next.js: ${e.message}`);
                }
            }

            // Fallback: استخراج من DOM إذا فشلت البيانات المخفية
            if (!item.title) {
                item.title = await page.evaluate(() =>
                    document.querySelector('h1')?.innerText?.trim() || ''
                );
            }
            if (!item.price_sar) {
                item.price_sar = await page.evaluate(() => {
                    const priceEl = document.querySelector('[class*="price"], [class*="Price"]');
                    return priceEl?.innerText?.replace(/[^\d]/g, '') || '';
                });
            }

            finalItems.push(item);
            await Actor.pushData(item);
            reqLog.info(`✅ عقار: ${item.title || 'بدون عنوان'} | السعر: ${item.price_sar || 'غير متوفر'} | الجوال: ${item.phone || 'غير متوفر'} | النشر: ${item.posted_at || 'غير متوفر'}`);

        // ==========================================
        // مسار 2: صفحة البحث وجمع روابط العقارات
        // ==========================================
        } else {
            // بناء رابط البحث
            let searchUrl = '';
            if (search && search.trim()) {
                searchUrl = `https://wasalt.sa/ar/${listingType}/search?cityId=${cityId}&countryId=1&propertyFor=${listingType}&type=${propertyType}&keyword=${encodeURIComponent(search)}`;
            } else {
                searchUrl = `https://wasalt.sa/ar/${listingType}/search?cityId=${cityId}&countryId=1&propertyFor=${listingType}&type=${propertyType}`;
            }

            reqLog.info(`البحث في وصلت: ${searchUrl}`);
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000);

            let collectedUrls = new Set();
            let attempts = 0;

            while (collectedUrls.size < maxResults && attempts < 15) {
                await page.mouse.wheel(0, 3000);
                await page.waitForTimeout(1500);

                const urls = await page.$$eval('a[href]', (anchors) => {
                    return anchors
                        .map(a => a.href)
                        .filter(href => href.match(/wasalt\.sa\/(ar|en)\/(sale|rent|property)\/[^/]+\d+/));
                });

                urls.forEach(u => collectedUrls.add(u));
                attempts++;

                reqLog.info(`محاولة ${attempts}: تم العثور على ${collectedUrls.size} رابط حتى الآن...`);
            }

            const urlsArray = Array.from(collectedUrls).slice(0, maxResults);
            reqLog.info(`🔍 تم العثور على ${urlsArray.length} عقار، جاري استخراج التفاصيل...`);

            for (const url of urlsArray) {
                await crawler.addRequests([{ url, userData: { label: 'DETAIL' } }]);
            }
        }
    },
    async failedRequestHandler({ request }, error) {
        log.error(`❌ فشل الطلب ${request.url}: ${error.message}`);
    },
});

await crawler.run([{ url: 'https://wasalt.sa/', userData: { label: 'SEARCH' } }]);

log.info(`🎉 اكتمل السحب! تم تصدير ${finalItems.length} عقار بكامل تفاصيلها.`);

// ── إرسال الـ Webhook ─────────────────────────────────────
if (webhookUrl && webhookUrl.trim() !== '') {
    const defaultDatasetId = process.env.APIFY_DEFAULT_DATASET_ID;
    const downloadUrl = `https://api.apify.com/v2/datasets/${defaultDatasetId}/items?format=json`;

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: 'success',
                searchQuery: search || city,
                itemsCount: finalItems.length,
                downloadUrl: downloadUrl,
            }),
        });
        log.info('✅ تم إرسال الـ Webhook بنجاح.');
    } catch (err) {
        log.error(`❌ فشل الاتصال بالـ Webhook: ${err.message}`);
    }
}

await Actor.exit();
