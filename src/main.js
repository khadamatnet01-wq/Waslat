// -*- coding: utf-8 -*-
// ============================================================
// WASALT / وصلت - Apify Actor
// استخراج الإعلانات + الهاتف + بيانات الإعلان
// يدعم: todayOnly = true / false
// ============================================================

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

// ============================================================
// INPUT
// ============================================================

const input = (await Actor.getInput()) || {};

const {
    city = 'الرياض',
    cityId = 273,
    listingType = 'sale',
    propertyType = 'residential',
    maxResults = 20,

    // جديد:
    // true  = إعلانات اليوم فقط
    // false = جميع الإعلانات
    todayOnly = false,

    // عدد دورات التمرير في صفحة البحث
    maxScrollRounds = 20,

    proxyConfiguration: proxyInput,

    webhookUrl = '',
} = input;

// ============================================================
// PROXY
// ============================================================

const proxyConfiguration =
    await Actor.createProxyConfiguration(
        proxyInput || {
            useApifyProxy: true,
            groups: ['RESIDENTIAL'],
        }
    );

// ============================================================
// LOG
// ============================================================

log.info(
    `🔍 todayOnly المُستلم = ${JSON.stringify(input.todayOnly)}`
);

log.info(
    `🔍 todayOnly المستخدم فعلياً = ${todayOnly}`
);

log.info(
    `🔍 المدينة = ${city} | cityId = ${cityId} | النوع = ${listingType} | propertyType = ${propertyType}`
);

// ============================================================
// STORAGE
// ============================================================

const finalItems = [];
const seenIds = new Set();
const detailQueuedIds = new Set();

// عدد الإعلانات التي تم حفظها فعلياً
let savedCount = 0;

// ============================================================
// HELPERS
// ============================================================

// ------------------------------------------------------------
// استخراج رقم هاتف سعودي
// ------------------------------------------------------------

function extractPhone(text) {
    if (!text) return '';

    const value = String(text)
        .replace(/[\u200e\u200f]/g, ' ');

    const patterns = [
        /(?:\+?966[\s-]?)?05[0-9]{8}/g,
        /(?:\+?966[\s-]?)?5[0-9]{8}/g,
    ];

    for (const pattern of patterns) {
        const matches = value.match(pattern);

        if (!matches) continue;

        for (let phone of matches) {
            phone = phone
                .replace(/\s/g, '')
                .replace(/-/g, '');

            if (phone.startsWith('+9665')) {
                phone = '0' + phone.slice(4);
            } else if (phone.startsWith('9665')) {
                phone = '0' + phone.slice(3);
            } else if (phone.startsWith('5')) {
                phone = '0' + phone;
            }

            if (/^05[0-9]{8}$/.test(phone)) {
                return phone;
            }
        }
    }

    return '';
}

// ------------------------------------------------------------
// تحويل التاريخ إلى Date
// ------------------------------------------------------------

function parseDate(value) {
    if (!value) return null;

    try {
        // dd/mm/yyyy
        if (
            typeof value === 'string' &&
            /^\d{2}\/\d{2}\/\d{4}$/.test(value)
        ) {
            const [dd, mm, yyyy] =
                value.split('/');

            const date =
                new Date(
                    `${yyyy}-${mm}-${dd}T00:00:00+03:00`
                );

            if (!isNaN(date.getTime())) {
                return date;
            }
        }

        const date = new Date(value);

        if (!isNaN(date.getTime())) {
            return date;
        }
    } catch {
        // ignore
    }

    return null;
}

// ------------------------------------------------------------
// تاريخ اليوم في الرياض
// ------------------------------------------------------------

function getRiyadhDateString(date = new Date()) {
    return new Intl.DateTimeFormat(
        'en-CA',
        {
            timeZone: 'Asia/Riyadh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }
    ).format(date);
}

// ------------------------------------------------------------
// هل التاريخ هو اليوم في الرياض؟
// ------------------------------------------------------------

function isTodayRiyadh(value) {
    const date = parseDate(value);

    if (!date) {
        return false;
    }

    const target =
        getRiyadhDateString(date);

    const today =
        getRiyadhDateString(new Date());

    return target === today;
}

// ------------------------------------------------------------
// تنسيق تاريخ الرياض
// ------------------------------------------------------------

function formatRiyadhDate(value) {
    const date = parseDate(value);

    if (!date) return '';

    return date.toLocaleString(
        'ar-SA',
        {
            timeZone: 'Asia/Riyadh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }
    );
}

// ============================================================
// CRAWLER
// ============================================================

const crawler = new PlaywrightCrawler({

    proxyConfiguration,

    // لا نرفع التوازي كثيراً حتى لا يتعرض الموقع للضغط
    maxConcurrency: 2,

    maxRequestsPerCrawl:
        Math.max(
            Number(maxResults) * 10,
            100
        ),

    requestHandlerTimeoutSecs: 180,

    navigationTimeoutSecs: 60,

    // ========================================================
    // REQUEST HANDLER
    // ========================================================

    async requestHandler({
        page,
        request,
        log: reqLog,
    }) {

        // ====================================================
        // SEARCH
        // ====================================================

        if (
            request.userData.label === 'SEARCH'
        ) {

            const searchUrl =
                `https://wasalt.sa/ar/${listingType}/search` +
                `?cityId=${cityId}` +
                `&countryId=1` +
                `&propertyFor=${listingType}` +
                `&type=${propertyType}`;

            reqLog.info(
                `🌐 فتح صفحة البحث: ${searchUrl}`
            );

            await page.goto(
                searchUrl,
                {
                    waitUntil:
                        'domcontentloaded',
                    timeout: 60000,
                }
            );

            try {
                await page.waitForSelector(
                    'a[href*="/property/"]',
                    {
                        timeout: 15000,
                    }
                );
            } catch {
                reqLog.warning(
                    '⚠️ لم تظهر بطاقات العقارات مباشرة...'
                );
            }

            await page.waitForTimeout(2000);

            // ------------------------------------------------
            // في الوضع العادي:
            // نتوقف عند maxResults.
            //
            // في todayOnly:
            // لا نتوقف بمجرد العثور على maxResults
            // لأننا لا نعرف تاريخ الإعلان إلا من صفحة التفاصيل.
            // ------------------------------------------------

            let staleRounds = 0;
            let previousCount = 0;

            for (
                let round = 1;
                round <= Number(maxScrollRounds);
                round++
            ) {

                // --------------------------------------------
                // استخراج البطاقات الحالية
                // --------------------------------------------

                const cards =
                    await page.evaluate(() => {

                        const results = [];

                        const seen =
                            new Set();

                        const links =
                            Array.from(
                                document.querySelectorAll(
                                    'a[href*="/property/"]'
                                )
                            );

                        for (
                            const link of links
                        ) {

                            const href =
                                link.href;

                            if (!href) continue;

                            // بعض الروابط قد تحتوي query/hash
                            const cleanHref =
                                href.split('?')[0]
                                    .split('#')[0];

                            const idMatch =
                                cleanHref.match(
                                    /-(\d+)$/
                                );

                            if (!idMatch) {
                                continue;
                            }

                            const id =
                                idMatch[1];

                            if (seen.has(id)) {
                                continue;
                            }

                            seen.add(id);

                            const card =
                                link.closest(
                                    'div, article, li'
                                ) ||
                                link.parentElement?.parentElement;

                            const cardText =
                                card?.innerText || '';

                            const priceMatch =
                                cardText.match(
                                    /([\d,]+)\s*(ريال|ر\.س)?/
                                );

                            const price =
                                priceMatch
                                    ? priceMatch[1]
                                        .replace(/,/g, '')
                                    : '';

                            const name =
                                link.getAttribute(
                                    'title'
                                ) ||
                                link.innerText
                                    ?.trim()
                                    .split('\n')[0] ||
                                '';

                            const addressEl =
                                card?.querySelector(
                                    '[class*="zone"],' +
                                    '[class*="district"],' +
                                    '[class*="address"],' +
                                    '[class*="location"]'
                                );

                            const address =
                                addressEl
                                    ?.innerText
                                    ?.trim() || '';

                            const imgEl =
                                card?.querySelector(
                                    'img'
                                );

                            const imgSrc =
                                imgEl?.src ||
                                imgEl?.getAttribute(
                                    'data-src'
                                ) ||
                                '';

                            results.push({
                                _raw_id: id,

                                name:
                                    name.trim(),

                                priceSar:
                                    price,

                                address,

                                has_image:
                                    !!imgSrc,

                                images:
                                    imgSrc
                                        ? [imgSrc]
                                        : [],

                                url:
                                    cleanHref,
                            });
                        }

                        return results;
                    });

                // --------------------------------------------
                // إضافة الإعلانات الجديدة
                // --------------------------------------------

                let newCount = 0;

                for (
                    const card of cards
                ) {

                    if (
                        seenIds.has(
                            card._raw_id
                        )
                    ) {
                        continue;
                    }

                    // في الوضع العادي فقط:
                    // نتوقف عند العدد المطلوب.
                    if (
                        !todayOnly &&
                        finalItems.length >=
                            Number(maxResults)
                    ) {
                        break;
                    }

                    seenIds.add(
                        card._raw_id
                    );

                    card.city =
                        city;

                    card.district =
                        '';

                    card.area_sqm =
                        '';

                    card.bedrooms =
                        '';

                    card.bathrooms =
                        '';

                    card.listing_type =
                        listingType;

                    card.source =
                        'wasalt';

                    card.phone =
                        '';

                    card.owner_name =
                        '';

                    card.rega_license =
                        '';

                    card.is_verified =
                        false;

                    card.posted_at =
                        '';

                    card.posted_at_iso =
                        '';

                    card.updated_at =
                        '';

                    card.scanned_at =
                        new Date().toISOString();

                    card._saved =
                        false;

                    // ----------------------------------------
                    // العنوان
                    // ----------------------------------------

                    if (card.address) {

                        const parts =
                            card.address.split(
                                '،'
                            );

                        card.district =
                            parts[0]
                                ?.trim() || '';

                        card.city =
                            parts[
                                parts.length - 1
                            ]
                                ?.trim() ||
                            city;
                    }

                    finalItems.push(
                        card
                    );

                    newCount++;
                }

                reqLog.info(
                    `📦 الجولة ${round}: تم اكتشاف ${finalItems.length} إعلان فريد`
                );

                // --------------------------------------------
                // إذا الوضع العادي
                // لا نحتاج الاستمرار
                // --------------------------------------------

                if (
                    !todayOnly &&
                    finalItems.length >=
                        Number(maxResults)
                ) {
                    break;
                }

                // --------------------------------------------
                // إذا لم نجد جديداً
                // --------------------------------------------

                if (
                    finalItems.length ===
                    previousCount
                ) {
                    staleRounds++;
                } else {
                    staleRounds = 0;
                }

                previousCount =
                    finalItems.length;

                // إذا لم يعد الموقع يعطينا شيئاً جديداً
                if (
                    staleRounds >= 3
                ) {
                    reqLog.info(
                        '🛑 لم تظهر إعلانات جديدة بعد عدة محاولات.'
                    );

                    break;
                }

                // --------------------------------------------
                // Scroll
                // --------------------------------------------

                await page.evaluate(() => {
                    window.scrollBy(
                        0,
                        window.innerHeight * 4
                    );
                });

                await page.waitForTimeout(
                    todayOnly ? 1800 : 2000
                );
            }

            reqLog.info(
                `🔎 إجمالي الإعلانات المرشحة للتفاصيل: ${finalItems.length}`
            );

            // =================================================
            // إضافة صفحات التفاصيل
            // =================================================

            for (
                const item of finalItems
            ) {

                if (
                    detailQueuedIds.has(
                        item._raw_id
                    )
                ) {
                    continue;
                }

                // الوضع العادي:
                if (
                    !todayOnly &&
                    detailQueuedIds.size >=
                        Number(maxResults)
                ) {
                    break;
                }

                detailQueuedIds.add(
                    item._raw_id
                );

                await crawler.addRequests([
                    {
                        url: item.url,

                        userData: {
                            label: 'DETAIL',
                            rawId:
                                item._raw_id,
                        },
                    },
                ]);
            }

            return;
        }

        // ====================================================
        // DETAIL
        // ====================================================

        if (
            request.userData.label ===
            'DETAIL'
        ) {

            const rawId =
                request.userData.rawId;

            reqLog.info(
                `📄 جلب تفاصيل العقار ${rawId}`
            );

            // ------------------------------------------------
            // حظر الصور والفيديو والخطوط
            // ------------------------------------------------

            await page.route(
                '**/*',
                async (route) => {

                    const type =
                        route.request()
                            .resourceType();

                    if (
                        [
                            'image',
                            'media',
                            'font',
                        ].includes(type)
                    ) {
                        await route.abort();
                    } else {
                        await route.continue();
                    }
                }
            );

            // ------------------------------------------------
            // فتح التفاصيل
            // ------------------------------------------------

            await page.goto(
                request.url,
                {
                    waitUntil:
                        'domcontentloaded',
                    timeout: 60000,
                }
            );

            try {

                await page.waitForSelector(
                    '[class*="description"],' +
                    '[class*="body"],' +
                    '[class*="desc"]',
                    {
                        timeout: 8000,
                    }
                );

            } catch {
                // نكمل
            }

            await page.waitForTimeout(
                1000
            );

            // ------------------------------------------------
            // قراءة النص
            // ------------------------------------------------

            const descriptionText =
                await page.evaluate(() => {

                    const selectors = [
                        '[class*="description"]',
                        '[class*="body"]',
                        '[class*="desc"]',
                        '[class*="property-info"]',
                        '[class*="detail"]',
                    ];

                    for (
                        const selector of selectors
                    ) {

                        const el =
                            document.querySelector(
                                selector
                            );

                        if (
                            el &&
                            el.textContent &&
                            el.textContent
                                .trim()
                                .length > 50
                        ) {
                            return el
                                .textContent
                                .trim();
                        }
                    }

                    return (
                        document.body
                            ?.innerText ||
                        ''
                    );
                });

            // ------------------------------------------------
            // الهاتف من النص
            // ------------------------------------------------

            let phone =
                extractPhone(
                    descriptionText
                );

            // ------------------------------------------------
            // __NEXT_DATA__
            // ------------------------------------------------

            const nextDataText =
                await page.evaluate(() => {

                    const el =
                        document.querySelector(
                            '#__NEXT_DATA__'
                        );

                    return el
                        ? el.textContent
                        : null;
                });

            // ------------------------------------------------
            // المتغيرات
            // ------------------------------------------------

            let posted_at =
                '';

            let posted_at_iso =
                '';

            let updated_at =
                '';

            let bedrooms =
                '';

            let bathrooms =
                '';

            let area_sqm =
                '';

            let district =
                '';

            let owner_name =
                '';

            let is_verified =
                false;

            let rega_license =
                '';

            // =================================================
            // تحليل NEXT_DATA
            // =================================================

            if (nextDataText) {

                try {

                    const data =
                        JSON.parse(
                            nextDataText
                        );

                    let propObj =
                        null;

                    // ----------------------------------------
                    // البحث عن property_info
                    // ----------------------------------------

                    const findProp =
                        (
                            obj,
                            depth = 0
                        ) => {

                            if (
                                depth > 15 ||
                                propObj ||
                                !obj ||
                                typeof obj !==
                                    'object'
                            ) {
                                return;
                            }

                            if (
                                obj.property_info &&
                                obj.id
                            ) {

                                propObj =
                                    obj;

                                return;
                            }

                            for (
                                const val of
                                    Object.values(
                                        obj
                                    )
                            ) {

                                findProp(
                                    val,
                                    depth + 1
                                );
                            }
                        };

                    findProp(data);

                    // ----------------------------------------
                    // Fallback: بعض نسخ Wasalt
                    // ----------------------------------------

                    if (!propObj) {

                        const findAlternative =
                            (
                                obj,
                                depth = 0
                            ) => {

                                if (
                                    depth > 15 ||
                                    propObj ||
                                    !obj ||
                                    typeof obj !==
                                        'object'
                                ) {
                                    return;
                                }

                                if (
                                    (
                                        obj.title ||
                                        obj.name
                                    ) &&
                                    (
                                        obj.price ||
                                        obj.createdAt ||
                                        obj.created_at ||
                                        obj.published_at
                                    )
                                ) {

                                    propObj =
                                        obj;

                                    return;
                                }

                                for (
                                    const val of
                                        Object.values(
                                            obj
                                        )
                                ) {

                                    findAlternative(
                                        val,
                                        depth + 1
                                    );
                                }
                            };

                        findAlternative(
                            data
                        );
                    }

                    // =================================================
                    // معالجة العقار
                    // =================================================

                    if (propObj) {

                        const info =
                            propObj.property_info ||
                            propObj.propertyInfo ||
                            {};

                        const owner =
                            propObj.property_owner ||
                            propObj.owner ||
                            {};

                        const rega =
                            propObj.rega_raw_info ||
                            propObj.rega ||
                            {};

                        // --------------------------------------------
                        // الهاتف
                        // --------------------------------------------

                        const nextPhone =
                            rega.phone_number ||
                            rega.responsible_employee_phone_number ||
                            owner.mobile ||
                            owner.phone ||
                            propObj.phone ||
                            propObj.mobile ||
                            propObj.contact_phone ||
                            '';

                        if (
                            nextPhone &&
                            !phone
                        ) {
                            phone =
                                extractPhone(
                                    String(
                                        nextPhone
                                    )
                                ) ||
                                String(
                                    nextPhone
                                );
                        }

                        // --------------------------------------------
                        // الهاتف من وصف الإعلان
                        // --------------------------------------------

                        if (!phone) {

                            const bodyText =
                                propObj.rega_moj_desc ||
                                info.description ||
                                propObj.description ||
                                '';

                            phone =
                                extractPhone(
                                    bodyText
                                );
                        }

                        // --------------------------------------------
                        // المعلن
                        // --------------------------------------------

                        owner_name =
                            owner.ar_name ||
                            owner.name ||
                            owner.full_name ||
                            propObj.advertiser_name ||
                            propObj.owner_name ||
                            '';

                        // --------------------------------------------
                        // التحقق
                        // --------------------------------------------

                        is_verified =
                            !!(
                                propObj.is_verified ||
                                propObj.is_rega_prop ||
                                propObj.verified
                            );

                        // --------------------------------------------
                        // المساحة
                        // --------------------------------------------

                        area_sqm =
                            String(
                                propObj.floor_size ||
                                rega.property_area ||
                                info.area ||
                                ''
                            );

                        // --------------------------------------------
                        // المنطقة
                        // --------------------------------------------

                        district =
                            info.zone ||
                            info.district ||
                            info.neighborhood ||
                            propObj.district ||
                            '';

                        // --------------------------------------------
                        // رخصة فال
                        // --------------------------------------------

                        rega_license =
                            rega.ad_license_number ||
                            rega.fal_license ||
                            owner.rega_adv_lic_no ||
                            propObj.fal_license ||
                            propObj.rega_license ||
                            '';

                        // --------------------------------------------
                        // الخصائص
                        // --------------------------------------------

                        const attrs =
                            propObj.attributes ||
                            [];

                        for (
                            const attr of attrs
                        ) {

                            if (
                                attr.key ===
                                'noOfBedrooms'
                            ) {
                                bedrooms =
                                    String(
                                        attr.value ||
                                        ''
                                    );
                            }

                            if (
                                attr.key ===
                                'noOfBathrooms'
                            ) {
                                bathrooms =
                                    String(
                                        attr.value ||
                                        ''
                                    );
                            }

                            if (
                                attr.key ===
                                    'builtUpArea' &&
                                !area_sqm
                            ) {
                                area_sqm =
                                    String(
                                        attr.value ||
                                        ''
                                    );
                            }
                        }

                        // --------------------------------------------
                        // تاريخ النشر
                        // --------------------------------------------

                        const rawPosted =
                            propObj.published_at ||
                            propObj.created_at ||
                            propObj.createdAt ||
                            info.published_at ||
                            info.created_at ||
                            rega.creation_date ||
                            rega.issue_date ||
                            '';

                        if (
                            rawPosted
                        ) {

                            const d =
                                parseDate(
                                    rawPosted
                                );

                            if (d) {

                                posted_at_iso =
                                    d.toISOString();

                                posted_at =
                                    formatRiyadhDate(
                                        d
                                    );
                            }
                        }

                        // --------------------------------------------
                        // تاريخ التحديث
                        // --------------------------------------------

                        const rawUpdated =
                            propObj.updated_at ||
                            propObj.updatedAt ||
                            info.updated_at ||
                            info.updatedAt ||
                            '';

                        if (
                            rawUpdated
                        ) {

                            const d =
                                parseDate(
                                    rawUpdated
                                );

                            if (d) {

                                updated_at =
                                    formatRiyadhDate(
                                        d
                                    );
                            }
                        }
                    }

                } catch (error) {

                    reqLog.warning(
                        `⚠️ فشل تحليل __NEXT_DATA__: ${error.message}`
                    );
                }
            }

            // =================================================
            // FALLBACK: tel:
            // =================================================

            if (!phone) {

                const telHref =
                    await page.evaluate(
                        () => {

                            const el =
                                document.querySelector(
                                    'a[href^="tel:"]'
                                );

                            return el
                                ? el.href
                                : '';
                        }
                    );

                if (telHref) {

                    phone =
                        extractPhone(
                            telHref
                                .replace(
                                    /^tel:/i,
                                    ''
                                )
                        );
                }
            }

            // =================================================
            // FALLBACK: التاريخ من DOM
            // =================================================

            if (!posted_at) {

                const domDate =
                    await page.evaluate(
                        () => {

                            const selectors = [
                                'time[datetime]',
                                '[class*="publish"]',
                                '[class*="date"]',
                            ];

                            for (
                                const selector of
                                    selectors
                            ) {

                                const el =
                                    document.querySelector(
                                        selector
                                    );

                                if (!el) {
                                    continue;
                                }

                                return (
                                    el.getAttribute(
                                        'datetime'
                                    ) ||
                                    el.innerText
                                        ?.trim() ||
                                    ''
                                );
                            }

                            return '';
                        }
                    );

                if (domDate) {

                    const d =
                        parseDate(
                            domDate
                        );

                    if (d) {

                        posted_at_iso =
                            d.toISOString();

                        posted_at =
                            formatRiyadhDate(
                                d
                            );
                    }
                }
            }

            // =================================================
            // إيجاد الإعلان في القائمة
            // =================================================

            const idx =
                finalItems.findIndex(
                    (item) =>
                        item._raw_id ===
                        rawId
                );

            if (idx === -1) {
                return;
            }

            // =================================================
            // تحديث البيانات
            // =================================================

            finalItems[idx].phone =
                phone || '';

            finalItems[idx].posted_at =
                posted_at || '';

            finalItems[idx].posted_at_iso =
                posted_at_iso || '';

            finalItems[idx].updated_at =
                updated_at || '';

            finalItems[idx].bedrooms =
                bedrooms ||
                finalItems[idx].bedrooms;

            finalItems[idx].bathrooms =
                bathrooms ||
                finalItems[idx].bathrooms;

            finalItems[idx].area_sqm =
                area_sqm ||
                finalItems[idx].area_sqm;

            finalItems[idx].district =
                district ||
                finalItems[idx].district;

            finalItems[idx].owner_name =
                owner_name;

            finalItems[idx].is_verified =
                is_verified;

            finalItems[idx].rega_license =
                rega_license;

            // =================================================
            // TODAY ONLY
            // =================================================

            if (todayOnly) {

                // --------------------------------------------
                // لا يوجد تاريخ موثوق
                // --------------------------------------------

                if (!posted_at_iso) {

                    reqLog.info(
                        `⏭️ ${rawId} — لا يوجد تاريخ نشر موثوق، تم تجاهله`
                    );

                    return;
                }

                // --------------------------------------------
                // الإعلان ليس من اليوم
                // --------------------------------------------

                if (
                    !isTodayRiyadh(
                        posted_at_iso
                    )
                ) {

                    reqLog.info(
                        `⏭️ ${rawId} — قديم | ${posted_at}`
                    );

                    return;
                }

                // --------------------------------------------
                // الإعلان من اليوم
                // --------------------------------------------

                reqLog.info(
                    `🟢 [إعلان اليوم] ${rawId} | ${posted_at}`
                );
            }

            // =================================================
            // MAX RESULTS
            // =================================================

            if (
                savedCount >=
                Number(maxResults)
            ) {

                reqLog.info(
                    `⏭️ تم الوصول إلى maxResults=${maxResults}`
                );

                return;
            }

            // =================================================
            // حفظ الإعلان
            // =================================================

            finalItems[idx]._saved =
                true;

            await Actor.pushData(
                finalItems[idx]
            );

            savedCount++;

            reqLog.info(
                `✅ تم حفظ الإعلان ${rawId} | ` +
                `${finalItems[idx].priceSar || ''} ريال | ` +
                `${phone || 'لا جوال'} | ` +
                `${posted_at || 'لا تاريخ'} | ` +
                `اليوم فقط=${todayOnly}`
            );
        }
    },

    // ========================================================
    // FAILED REQUEST
    // ========================================================

    async failedRequestHandler({
        request,
        error,
    }) {

        const rawId =
            request.userData?.rawId;

        // لا نحفظ إعلاناً فاشلاً عندما todayOnly=true
        // لأننا لا نستطيع التأكد من تاريخ نشره.

        if (
            request.userData?.label ===
                'DETAIL' &&
            !todayOnly
        ) {

            const idx =
                finalItems.findIndex(
                    (item) =>
                        item._raw_id ===
                        rawId
                );

            if (
                idx !== -1 &&
                !finalItems[idx]._saved
            ) {

                finalItems[idx]._saved =
                    true;

                await Actor.pushData(
                    finalItems[idx]
                );
            }
        }

        log.error(
            `❌ فشل: ${request.url} — ${error.message}`
        );
    },
});

// ============================================================
// START
// ============================================================

const searchUrl =
    `https://wasalt.sa/ar/${listingType}/search` +
    `?cityId=${cityId}` +
    `&countryId=1` +
    `&propertyFor=${listingType}` +
    `&type=${propertyType}`;

log.info(
    `🚀 بدء البحث`
);

log.info(
    `📍 المدينة: ${city}`
);

log.info(
    `📅 todayOnly: ${todayOnly}`
);

if (todayOnly) {

    log.info(
        `📅 تاريخ الرياض المستهدف: ${getRiyadhDateString()}`
    );
}

// ============================================================
// RUN
// ============================================================

await crawler.run([
    {
        url: searchUrl,

        userData: {
            label: 'SEARCH',
        },
    },
]);

// ============================================================
// SUMMARY
// ============================================================

log.info(
    `================================================`
);

log.info(
    `🎉 انتهى الأكتور`
);

log.info(
    `📊 الإعلانات المكتشفة: ${finalItems.length}`
);

log.info(
    `✅ الإعلانات المحفوظة: ${savedCount}`
);

log.info(
    `📅 todayOnly: ${todayOnly}`
);

log.info(
    `================================================`
);

// ============================================================
// WEBHOOK
// ============================================================

if (
    webhookUrl &&
    webhookUrl.trim()
) {

    try {

        const datasetId =
            process.env
                .APIFY_DEFAULT_DATASET_ID;

        const downloadUrl =
            `https://api.apify.com/v2/datasets/${datasetId}/items?format=json`;

        await fetch(
            webhookUrl,
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json',
                },

                body: JSON.stringify({
                    status:
                        'success',

                    city,

                    cityId,

                    listingType,

                    propertyType,

                    todayOnly,

                    itemsCount:
                        savedCount,

                    datasetId,

                    downloadUrl,

                    scannedAt:
                        new Date().toISOString(),
                }),
            }
        );

        log.info(
            '✅ Webhook أُرسل بنجاح.'
        );

    } catch (error) {

        log.error(
            `❌ فشل Webhook: ${error.message}`
        );
    }
}

// ============================================================
// EXIT
// ============================================================

await Actor.exit();
