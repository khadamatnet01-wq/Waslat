  // -*- coding: utf-8 -*-
// ============================================================
// WASALT / وصلت - Apify Actor
// البحث بالمدينة + الحي + نوع العقار
// يدعم: اليوم فقط + استخراج الهاتف
// ============================================================

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};

const {
    city = 'الرياض',
    district = '',
    listingType = 'sale',
    propertyType = 'residential',
    maxResults = 20,
    todayOnly = false,
    maxScrollRounds = 20,
    fetchPhoneFromDetail = true,
    proxyConfiguration: proxyInput,
    webhookUrl = ''
} = input;

// ============================================================
// PROXY
// ============================================================

const proxyConfiguration =
    await Actor.createProxyConfiguration(
        proxyInput || {
            useApifyProxy: true,
            groups: ['RESIDENTIAL']
        }
    );

// ============================================================
// STATE
// ============================================================

const candidates = [];
const seenIds = new Set();
const queuedIds = new Set();

let savedCount = 0;

// ============================================================
// HELPERS
// ============================================================

function cleanText(value) {
    return String(value || '')
        .replace(/\u200e/g, '')
        .replace(/\u200f/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ------------------------------------------------------------
// الهاتف
// ------------------------------------------------------------

function extractPhone(value) {
    if (!value) return '';

    let text = String(value)
        .replace(/[()\-\s]/g, '');

    const patterns = [
        /(?:\+966|966)?05\d{8}/,
        /(?:\+966|966)?5\d{8}/
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);

        if (!match) continue;

        let phone = match[0];

        if (phone.startsWith('+966')) {
            phone = '0' + phone.slice(4);
        } else if (phone.startsWith('966')) {
            phone = '0' + phone.slice(3);
        } else if (phone.startsWith('5')) {
            phone = '0' + phone;
        }

        if (/^05\d{8}$/.test(phone)) {
            return phone;
        }
    }

    return '';
}

// ------------------------------------------------------------
// التاريخ
// ------------------------------------------------------------

function parseDate(value) {
    if (!value) return null;

    if (
        typeof value === 'string' &&
        /^\d{2}\/\d{2}\/\d{4}$/.test(value)
    ) {
        const [d, m, y] = value.split('/');

        const date = new Date(
            `${y}-${m}-${d}T00:00:00+03:00`
        );

        if (!isNaN(date.getTime())) {
            return date;
        }
    }

    const date = new Date(value);

    return isNaN(date.getTime())
        ? null
        : date;
}

function riyadhDate(value = new Date()) {
    return new Intl.DateTimeFormat(
        'en-CA',
        {
            timeZone: 'Asia/Riyadh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }
    ).format(value);
}

function isToday(value) {
    const date = parseDate(value);

    if (!date) return false;

    return (
        riyadhDate(date) ===
        riyadhDate()
    );
}

function formatDate(value) {
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
            minute: '2-digit'
        }
    );
}

// ============================================================
// BUILD SEARCH PAGE
// ============================================================

const searchUrl =
    `https://wasalt.sa/ar/${listingType}/search`;

log.info('==========================================');
log.info('🚀 بدء أكتور وصلت');
log.info(`📍 المدينة: ${city}`);
log.info(`🏘️ الحي: ${district || 'جميع الأحياء'}`);
log.info(`🏠 النوع: ${propertyType}`);
log.info(
    `📅 اليوم فقط: ${todayOnly}`
);
log.info(
    `📞 استخراج الهاتف: ${fetchPhoneFromDetail}`
);
log.info('==========================================');

// ============================================================
// CRAWLER
// ============================================================

const crawler = new PlaywrightCrawler({

    proxyConfiguration,

    maxConcurrency: 2,

    maxRequestsPerCrawl:
        Math.max(
            Number(maxResults) * 8,
            100
        ),

    requestHandlerTimeoutSecs: 180,

    navigationTimeoutSecs: 60000,

    async requestHandler({
        page,
        request,
        log: reqLog
    }) {

        // ====================================================
        // SEARCH
        // ====================================================

        if (
            request.userData.label ===
            'SEARCH'
        ) {

            reqLog.info(
                `🌐 فتح: ${searchUrl}`
            );

            await page.goto(
                searchUrl,
                {
                    waitUntil:
                        'domcontentloaded',
                    timeout: 60000
                }
            );

            await page.waitForTimeout(2500);

            // =================================================
            // اختيار المدينة والحي
            // =================================================

            await selectSearchLocation(
                page,
                city,
                district,
                reqLog
            );

            // =================================================
            // محاولة تحديد نوع العقار
            // =================================================

            await selectPropertyType(
                page,
                propertyType,
                reqLog
            );

            await page.waitForTimeout(1500);

            // =================================================
            // الضغط على بحث
            // =================================================

            await clickSearch(
                page,
                reqLog
            );

            await page.waitForTimeout(3000);

            // =================================================
            // جمع النتائج
            // =================================================

            let previousCount = 0;
            let staleRounds = 0;

            for (
                let round = 1;
                round <= Number(maxScrollRounds);
                round++
            ) {

                const cards =
                    await extractCards(page);

                let added = 0;

                for (
                    const card of cards
                ) {

                    if (
                        seenIds.has(
                            card.id
                        )
                    ) {
                        continue;
                    }

                    if (
                        !todayOnly &&
                        candidates.length >=
                        Number(maxResults)
                    ) {
                        break;
                    }

                    seenIds.add(card.id);

                    candidates.push({
                        _raw_id: card.id,

                        url: card.url,

                        title:
                            card.title,

                        priceSar:
                            card.priceSar,

                        address:
                            card.address,

                        city:
                            city,

                        district:
                            card.district ||
                            district,

                        listing_type:
                            listingType,

                        property_type:
                            propertyType,

                        source:
                            'wasalt',

                        phone: '',

                        owner_name: '',

                        area_sqm: '',

                        bedrooms: '',

                        bathrooms: '',

                        rega_license: '',

                        is_verified: false,

                        posted_at: '',

                        posted_at_iso: '',

                        updated_at: '',

                        scanned_at:
                            new Date().toISOString(),

                        _saved: false
                    });

                    added++;
                }

                reqLog.info(
                    `📦 الجولة ${round}: ` +
                    `${candidates.length} إعلان`
                );

                if (
                    !todayOnly &&
                    candidates.length >=
                    Number(maxResults)
                ) {
                    break;
                }

                if (
                    candidates.length ===
                    previousCount
                ) {
                    staleRounds++;
                } else {
                    staleRounds = 0;
                }

                previousCount =
                    candidates.length;

                if (staleRounds >= 3) {
                    reqLog.info(
                        '🛑 لا توجد نتائج جديدة.'
                    );
                    break;
                }

                await page.evaluate(
                    () => {
                        window.scrollBy(
                            0,
                            window.innerHeight * 4
                        );
                    }
                );

                await page.waitForTimeout(
                    todayOnly
                        ? 1500
                        : 1200
                );
            }

            reqLog.info(
                `🔎 المرشحون: ${candidates.length}`
            );

            // =================================================
            // صفحات التفاصيل
            // =================================================

            for (
                const item of candidates
            ) {

                if (
                    queuedIds.has(
                        item._raw_id
                    )
                ) {
                    continue;
                }

                if (
                    !todayOnly &&
                    queuedIds.size >=
                    Number(maxResults)
                ) {
                    break;
                }

                queuedIds.add(
                    item._raw_id
                );

                await crawler.addRequests([
                    {
                        url: item.url,

                        userData: {
                            label:
                                'DETAIL',

                            rawId:
                                item._raw_id
                        }
                    }
                ]);
            }

            return;
        }

        // ====================================================
        // DETAIL
        // ====================================================

        if (
            request.userData.label !==
            'DETAIL'
        ) {
            return;
        }

        const rawId =
            request.userData.rawId;

        reqLog.info(
            `📄 تفاصيل: ${rawId}`
        );

        // ----------------------------------------------------
        // منع الصور
        // ----------------------------------------------------

        await page.route(
            '**/*',
            async route => {

                const type =
                    route.request()
                        .resourceType();

                if (
                    [
                        'image',
                        'media',
                        'font'
                    ].includes(type)
                ) {
                    await route.abort();
                } else {
                    await route.continue();
                }
            }
        );

        await page.goto(
            request.url,
            {
                waitUntil:
                    'domcontentloaded',
                timeout: 60000
            }
        );

        await page.waitForTimeout(1200);

        // ====================================================
        // الصفحة كاملة
        // ====================================================

        const bodyText =
            await page.locator('body')
                .innerText()
                .catch(() => '');

        let phone =
            extractPhone(bodyText);

        // ====================================================
        // TEL
        // ====================================================

        if (!phone) {

            phone =
                await page.evaluate(
                    () => {

                        const links =
                            Array.from(
                                document.querySelectorAll(
                                    'a[href^="tel:"],a[href*="tel:"]'
                                )
                            );

                        for (
                            const link of links
                        ) {

                            const href =
                                link.href ||
                                link.getAttribute(
                                    'href'
                                ) ||
                                '';

                            if (href) {
                                return href;
                            }
                        }

                        return '';
                    }
                );

            phone =
                extractPhone(phone);
        }

        // ====================================================
        // محاولة كشف الهاتف عبر زر الاتصال
        // ====================================================

        if (
            !phone &&
            fetchPhoneFromDetail
        ) {

            try {

                const buttons =
                    page.locator(
                        'button, a'
                    );

                const count =
                    await buttons.count();

                for (
                    let i = 0;
                    i < count;
                    i++
                ) {

                    const button =
                        buttons.nth(i);

                    const text =
                        cleanText(
                            await button
                                .innerText()
                                .catch(
                                    () => ''
                                )
                        );

                    const aria =
                        cleanText(
                            await button
                                .getAttribute(
                                    'aria-label'
                                )
                                .catch(
                                    () => ''
                                )
                        );

                    const label =
                        `${text} ${aria}`;

                    if (
                        !/اتصال|اتصل|جوال|هاتف|call|phone/i
                            .test(label)
                    ) {
                        continue;
                    }

                    await button
                        .click({
                            timeout: 3000
                        })
                        .catch(
                            () => {}
                        );

                    await page.waitForTimeout(
                        700
                    );

                    const tel =
                        await page.evaluate(
                            () => {

                                const links =
                                    Array.from(
                                        document.querySelectorAll(
                                            'a[href^="tel:"],a[href*="tel:"]'
                                        )
                                    );

                                return links.length
                                    ? (
                                        links[
                                            links.length - 1
                                        ].href || ''
                                    )
                                    : '';
                            }
                        );

                    phone =
                        extractPhone(tel);

                    if (phone) {
                        break;
                    }

                    const afterText =
                        await page
                            .locator('body')
                            .innerText()
                            .catch(
                                () => ''
                            );

                    phone =
                        extractPhone(
                            afterText
                        );

                    if (phone) {
                        break;
                    }
                }

            } catch (error) {

                reqLog.warning(
                    `⚠️ تعذر كشف الهاتف بالزر: ${error.message}`
                );
            }
        }

        // ====================================================
        // NEXT DATA
        // ====================================================

        let postedAt = '';
        let updatedAt = '';
        let ownerName = '';
        let districtValue = '';
        let area = '';
        let bedrooms = '';
        let bathrooms = '';
        let rega = '';
        let verified = false;

        const nextData =
            await page.evaluate(
                () => {

                    const el =
                        document.querySelector(
                            '#__NEXT_DATA__'
                        );

                    return el
                        ? el.textContent
                        : '';
                }
            );

        if (nextData) {

            try {

                const data =
                    JSON.parse(nextData);

                const objects = [];

                function walk(
                    value,
                    depth = 0
                ) {

                    if (
                        depth > 12 ||
                        value === null ||
                        typeof value !==
                        'object'
                    ) {
                        return;
                    }

                    if (
                        value &&
                        typeof value ===
                        'object'
                    ) {
                        objects.push(value);
                    }

                    for (
                        const child of
                        Object.values(value)
                    ) {
                        walk(
                            child,
                            depth + 1
                        );
                    }
                }

                walk(data);

                // --------------------------------------------
                // العثور على الكائن الأكثر احتمالاً
                // --------------------------------------------

                const prop =
                    objects.find(
                        x =>
                            x.property_info &&
                            (
                                x.id ||
                                x.property_id
                            )
                    ) ||
                    objects.find(
                        x =>
                            (
                                x.title ||
                                x.name
                            ) &&
                            (
                                x.created_at ||
                                x.createdAt ||
                                x.published_at
                            )
                    );

                if (prop) {

                    const info =
                        prop.property_info ||
                        prop.propertyInfo ||
                        {};

                    const owner =
                        prop.property_owner ||
                        prop.owner ||
                        {};

                    const regaInfo =
                        prop.rega_raw_info ||
                        prop.rega ||
                        {};

                    // ----------------------------------------
                    // الهاتف
                    // ----------------------------------------

                    const phoneValues = [
                        regaInfo.phone_number,
                        regaInfo.responsible_employee_phone_number,
                        owner.mobile,
                        owner.phone,
                        owner.mobile_number,
                        prop.phone,
                        prop.mobile,
                        prop.mobile_number,
                        prop.contact_phone
                    ];

                    for (
                        const value of
                        phoneValues
                    ) {

                        if (!phone && value) {
                            phone =
                                extractPhone(
                                    value
                                );
                        }

                        if (phone) break;
                    }

                    // ----------------------------------------
                    // المعلن
                    // ----------------------------------------

                    ownerName =
                        owner.ar_name ||
                        owner.name ||
                        owner.full_name ||
                        prop.advertiser_name ||
                        prop.owner_name ||
                        '';

                    // ----------------------------------------
                    // الحي
                    // ----------------------------------------

                    districtValue =
                        info.zone ||
                        info.district ||
                        info.neighborhood ||
                        prop.district ||
                        '';

                    // ----------------------------------------
                    // المساحة
                    // ----------------------------------------

                    area =
                        prop.floor_size ||
                        regaInfo.property_area ||
                        info.area ||
                        '';

                    // ----------------------------------------
                    // التحقق
                    // ----------------------------------------

                    verified =
                        !!(
                            prop.is_verified ||
                            prop.is_rega_prop ||
                            prop.verified
                        );

                    // ----------------------------------------
                    // رخصة فال
                    // ----------------------------------------

                    rega =
                        regaInfo.ad_license_number ||
                        regaInfo.fal_license ||
                        owner.rega_adv_lic_no ||
                        prop.fal_license ||
                        prop.rega_license ||
                        '';

                    // ----------------------------------------
                    // التاريخ
                    // ----------------------------------------

                    const posted =
                        prop.published_at ||
                        prop.created_at ||
                        prop.createdAt ||
                        info.published_at ||
                        info.created_at ||
                        regaInfo.creation_date ||
                        regaInfo.issue_date ||
                        '';

                    const updated =
                        prop.updated_at ||
                        prop.updatedAt ||
                        info.updated_at ||
                        info.updatedAt ||
                        '';

                    if (posted) {
                        postedAt = posted;
                    }

                    if (updated) {
                        updatedAt = updated;
                    }

                    // ----------------------------------------
                    // الخصائص
                    // ----------------------------------------

                    for (
                        const attr of
                        prop.attributes || []
                    ) {

                        if (
                            attr.key ===
                            'noOfBedrooms'
                        ) {
                            bedrooms =
                                attr.value;
                        }

                        if (
                            attr.key ===
                            'noOfBathrooms'
                        ) {
                            bathrooms =
                                attr.value;
                        }

                        if (
                            attr.key ===
                            'builtUpArea' &&
                            !area
                        ) {
                            area =
                                attr.value;
                        }
                    }
                }

            } catch (error) {

                reqLog.warning(
                    `⚠️ NEXT_DATA: ${error.message}`
                );
            }
        }

        // ====================================================
        // التاريخ من DOM
        // ====================================================

        if (!postedAt) {

            postedAt =
                await page.evaluate(
                    () => {

                        const selectors = [
                            'time[datetime]',
                            '[class*="publish"]',
                            '[class*="posted"]',
                            '[class*="date"]'
                        ];

                        for (
                            const selector of
                            selectors
                        ) {

                            const el =
                                document.querySelector(
                                    selector
                                );

                            if (!el) continue;

                            return (
                                el.getAttribute(
                                    'datetime'
                                ) ||
                                el.innerText ||
                                ''
                            );
                        }

                        return '';
                    }
                );
        }

        // ====================================================
        // تحديث العنصر
        // ====================================================

        const index =
            candidates.findIndex(
                item =>
                    item._raw_id ===
                    rawId
            );

        if (index === -1) {
            return;
        }

        const item =
            candidates[index];

        item.phone =
            phone || '';

        item.owner_name =
            cleanText(ownerName);

        item.district =
            cleanText(
                districtValue ||
                item.district ||
                district
            );

        item.area_sqm =
            String(area || '');

        item.bedrooms =
            String(bedrooms || '');

        item.bathrooms =
            String(bathrooms || '');

        item.rega_license =
            String(rega || '');

        item.is_verified =
            verified;

        const postedDate =
            parseDate(postedAt);

        if (postedDate) {

            item.posted_at_iso =
                postedDate.toISOString();

            item.posted_at =
                formatDate(
                    postedDate
                );
        }

        const updatedDate =
            parseDate(updatedAt);

        if (updatedDate) {

            item.updated_at =
                formatDate(
                    updatedDate
                );
        }

        // ====================================================
        // TODAY ONLY
        // ====================================================

        if (todayOnly) {

            if (
                !item.posted_at_iso
            ) {

                reqLog.info(
                    `⏭️ ${rawId} — بدون تاريخ موثوق`
                );

                return;
            }

            if (
                !isToday(
                    item.posted_at_iso
                )
            ) {

                reqLog.info(
                    `⏭️ ${rawId} — قديم | ${item.posted_at}`
                );

                return;
            }

            reqLog.info(
                `🟢 إعلان اليوم: ${rawId}`
            );
        }

        // ====================================================
        // MAX RESULTS
        // ====================================================

        if (
            savedCount >=
            Number(maxResults)
        ) {
            return;
        }

        // ====================================================
        // SAVE
        // ====================================================

        item._saved = true;

        await Actor.pushData(
            item
        );

        savedCount++;

        reqLog.info(
            `✅ حفظ ${rawId} | ` +
            `📞 ${item.phone || 'لا يوجد'} | ` +
            `📅 ${item.posted_at || 'لا يوجد'}`
        );
    },

    // ========================================================
    // FAILED
    // ========================================================

    async failedRequestHandler({
        request,
        error
    }) {

        log.error(
            `❌ فشل الطلب: ${request.url} | ${error.message}`
        );
    }
});

// ============================================================
// SEARCH PAGE HELPERS
// ============================================================

async function selectSearchLocation(
    page,
    city,
    district,
    reqLog
) {

    // --------------------------------------------------------
    // المدينة
    // --------------------------------------------------------

    if (city) {

        const cityInput =
            page.locator(
                'input'
            ).filter({
                has: undefined
            });

        const inputs =
            page.locator(
                'input'
            );

        const count =
            await inputs.count();

        for (
            let i = 0;
            i < count;
            i++
        ) {

            const el =
                inputs.nth(i);

            const placeholder =
                cleanText(
                    await el
                        .getAttribute(
                            'placeholder'
                        )
                        .catch(
                            () => ''
                        )
                );

            const aria =
                cleanText(
                    await el
                        .getAttribute(
                            'aria-label'
                        )
                        .catch(
                            () => ''
                        )
                );

            const name =
                cleanText(
                    await el
                        .getAttribute(
                            'name'
                        )
                        .catch(
                            () => ''
                        )
                );

            const label =
                `${placeholder} ${aria} ${name}`;

            if (
                /مدينة|city/i.test(label)
            ) {

                await el
                    .fill(city)
                    .catch(
                        () => {}
                    );

                await page.waitForTimeout(
                    800
                );

                await chooseSuggestion(
                    page,
                    city
                );

                reqLog.info(
                    `📍 المدينة: ${city}`
                );

                break;
            }
        }
    }

    // --------------------------------------------------------
    // الحي
    // --------------------------------------------------------

    if (district) {

        const inputs =
            page.locator(
                'input'
            );

        const count =
            await inputs.count();

        for (
            let i = 0;
            i < count;
            i++
        ) {

            const el =
                inputs.nth(i);

            const placeholder =
                cleanText(
                    await el
                        .getAttribute(
                            'placeholder'
                        )
                        .catch(
                            () => ''
                        )
                );

            const aria =
                cleanText(
                    await el
                        .getAttribute(
                            'aria-label'
                        )
                        .catch(
                            () => ''
                        )
                );

            const name =
                cleanText(
                    await el
                        .getAttribute(
                            'name'
                        )
                        .catch(
                            () => ''
                        )
                );

            const label =
                `${placeholder} ${aria} ${name}`;

            if (
                /حي|district|neighborhood/i
                    .test(label)
            ) {

                await el
                    .fill(district)
                    .catch(
                        () => {}
                    );

                await page.waitForTimeout(
                    800
                );

                await chooseSuggestion(
                    page,
                    district
                );

                reqLog.info(
                    `🏘️ الحي: ${district}`
                );

                break;
            }
        }
    }
}

// ============================================================
// اختيار الاقتراح
// ============================================================

async function chooseSuggestion(
    page,
    value
) {

    const text =
        cleanText(value);

    const selectors = [
        `[role="option"]`,
        'li',
        '[class*="suggest"]',
        '[class*="autocomplete"]',
        '[class*="option"]'
    ];

    for (
        const selector of selectors
    ) {

        const locator =
            page.locator(
                selector
            );

        const count =
            await locator.count();

        for (
            let i = 0;
            i < Math.min(count, 15);
            i++
        ) {

            const item =
                locator.nth(i);

            const itemText =
                cleanText(
                    await item
                        .innerText()
                        .catch(
                            () => ''
                        )
                );

            if (
                itemText &&
                (
                    itemText === text ||
                    itemText.includes(text)
                )
            ) {

                await item
                    .click()
                    .catch(
                        () => {}
                    );

                return true;
            }
        }
    }

    return false;
}

// ============================================================
// نوع العقار
// ============================================================

async function selectPropertyType(
    page,
    type,
    reqLog
) {

    if (!type) return;

    const wanted =
        /residential/i.test(type)
            ? 'سكني'
            : type;

    const elements =
        page.locator(
            'button, [role="button"], select'
        );

    const count =
        await elements.count();

    for (
        let i = 0;
        i < count;
        i++
    ) {

        const el =
            elements.nth(i);

        const text =
            cleanText(
                await el
                    .innerText()
                    .catch(
                        () => ''
                    )
            );

        if (
            /نوع العقار|property type/i
                .test(text)
        ) {

            await el
                .click()
                .catch(
                    () => {}
                );

            await page.waitForTimeout(
                400
            );

            await chooseSuggestion(
                page,
                wanted
            );

            return;
        }
    }
}

// ============================================================
// زر البحث
// ============================================================

async function clickSearch(
    page,
    reqLog
) {

    const buttons =
        page.locator(
            'button, [role="button"]'
        );

    const count =
        await buttons.count();

    for (
        let i = 0;
        i < count;
        i++
    ) {

        const button =
            buttons.nth(i);

        const text =
            cleanText(
                await button
                    .innerText()
                    .catch(
                        () => ''
                    )
            );

        if (
            /^بحث$|^search$/i.test(text)
        ) {

            await button
                .click()
                .catch(
                    () => {}
                );

            reqLog.info(
                '🔎 تم الضغط على بحث'
            );

            return;
        }
    }

    // fallback
    await page.keyboard
        .press('Enter')
        .catch(
            () => {}
        );
}

// ============================================================
// استخراج بطاقات العقار
// ============================================================

async function extractCards(
    page
) {

    return await page.evaluate(
        () => {

            const results = [];
            const ids = new Set();

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
                    link.href || '';

                if (!href) continue;

                const url =
                    href
                        .split('?')[0]
                        .split('#')[0];

                const match =
                    url.match(
                        /-(\d+)$/
                    );

                if (!match) continue;

                const id =
                    match[1];

                if (ids.has(id)) {
                    continue;
                }

                ids.add(id);

                const card =
                    link.closest(
                        'article, li'
                    ) ||
                    link.parentElement?.parentElement ||
                    link.parentElement;

                const text =
                    card?.innerText || '';

                const priceMatch =
                    text.match(
                        /([\d,]+)\s*(?:ريال|ر\.س)/
                    );

                const priceSar =
                    priceMatch
                        ? priceMatch[1]
                            .replace(
                                /,/g,
                                ''
                            )
                        : '';

                const title =
                    link.getAttribute(
                        'title'
                    ) ||
                    link.innerText
                        ?.trim()
                        .split('\n')[0] ||
                    '';

                const address =
                    (
                        card?.querySelector(
                            '[class*="address"],' +
                            '[class*="district"],' +
                            '[class*="location"],' +
                            '[class*="zone"]'
                        )?.innerText ||
                        ''
                    ).trim();

                let cardDistrict = '';

                if (address) {

                    const parts =
                        address.split(
                            '،'
                        );

                    if (
                        parts.length >= 2
                    ) {
                        cardDistrict =
                            parts[0].trim();
                    }
                }

                results.push({
                    id,

                    url,

                    title:
                        title.trim(),

                    priceSar,

                    address:
                        address.trim(),

                    district:
                        cardDistrict
                });
            }

            return results;
        }
    );
}

// ============================================================
// START
// ============================================================

await crawler.run([
    {
        url: searchUrl,

        userData: {
            label: 'SEARCH'
        }
    }
]);

// ============================================================
// SUMMARY
// ============================================================

log.info(
    '=========================================='
);

log.info(
    '🎉 انتهى السحب'
);

log.info(
    `📍 المدينة: ${city}`
);

log.info(
    `🏘️ الحي: ${district || 'الكل'}`
);

log.info(
    `📊 المرشحون: ${candidates.length}`
);

log.info(
    `✅ المحفوظ: ${savedCount}`
);

log.info(
    `📅 اليوم فقط: ${todayOnly}`
);

log.info(
    '=========================================='
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

        await fetch(
            webhookUrl,
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json'
                },

                body: JSON.stringify({
                    status:
                        'success',

                    city,

                    district,

                    listingType,

                    propertyType,

                    todayOnly,

                    itemsCount:
                        savedCount,

                    datasetId,

                    scannedAt:
                        new Date()
                            .toISOString()
                })
            }
        );

        log.info(
            '✅ تم إرسال Webhook'
        );

    } catch (error) {

        log.error(
            `❌ Webhook: ${error.message}`
        );
    }
}

await Actor.exit();
