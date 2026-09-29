// ============================================================
// WASALT SCRAPER - سريع + استخراج الهاتف + Webhook
// ============================================================

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

// ------------------------------------------------------------
// تشغيل Actor
// ------------------------------------------------------------

await Actor.init();

const input = (await Actor.getInput()) || {};

const {
    city = 'الرياض',
    cityId = 273,
    listingType = 'sale',
    propertyType = 'residential',
    maxResults = 20,
    webhookUrl = '',
} = input;

// ------------------------------------------------------------
// إعداد Proxy
// ------------------------------------------------------------

const proxyConfiguration = await Actor.createProxyConfiguration(
    input.proxy || {}
);

// ------------------------------------------------------------
// متغيرات عامة
// ------------------------------------------------------------

const finalItems = new Map();
const discoveredIds = new Set();

let searchFinished = false;

// ------------------------------------------------------------
// أدوات مساعدة
// ------------------------------------------------------------

function cleanText(value) {
    if (value === undefined || value === null) return '';

    return String(value)
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizePhone(phone) {
    if (!phone) return '';

    let value = String(phone)
        .replace(/[^\d+]/g, '')
        .trim();

    // +9665XXXXXXXX
    if (value.startsWith('+9665') && value.length >= 13) {
        return '05' + value.slice(4);
    }

    // 9665XXXXXXXX
    if (value.startsWith('9665') && value.length >= 12) {
        return '05' + value.slice(3);
    }

    // 5XXXXXXXX
    if (/^5\d{8}$/.test(value)) {
        return '0' + value;
    }

    // 05XXXXXXXX
    if (/^05\d{8}$/.test(value)) {
        return value;
    }

    return '';
}

function extractPhone(text) {
    if (!text) return '';

    const value = String(text);

    const patterns = [
        /(?:\+?966[\s-]?)?05\d{8}/g,
        /(?:\+?966[\s-]?)?5\d{8}/g,
    ];

    for (const regex of patterns) {
        const matches = value.match(regex);

        if (matches?.length) {
            for (const match of matches) {
                const phone = normalizePhone(match);

                if (phone) {
                    return phone;
                }
            }
        }
    }

    return '';
}

function extractIdFromUrl(url) {
    if (!url) return '';

    const match = url.match(/-(\d+)(?:\/)?$/);

    return match ? match[1] : '';
}

function absoluteUrl(url) {
    if (!url) return '';

    if (url.startsWith('http://') || url.startsWith('https://')) {
        return url;
    }

    if (url.startsWith('/')) {
        return `https://wasalt.sa${url}`;
    }

    return `https://wasalt.sa/${url}`;
}

function firstValue(...values) {
    for (const value of values) {
        if (
            value !== undefined &&
            value !== null &&
            value !== ''
        ) {
            return value;
        }
    }

    return '';
}

// ------------------------------------------------------------
// استخراج JSON من HTML
// ------------------------------------------------------------

function extractNextData(html) {
    if (!html) return null;

    const match = html.match(
        /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
    );

    if (!match) return null;

    try {
        return JSON.parse(match[1]);
    } catch {
        return null;
    }
}

// ------------------------------------------------------------
// بحث عميق داخل JSON
// ------------------------------------------------------------

function deepFindObjects(value, predicate, results = [], seen = new Set()) {
    if (value === null || value === undefined) {
        return results;
    }

    if (typeof value !== 'object') {
        return results;
    }

    if (seen.has(value)) {
        return results;
    }

    seen.add(value);

    try {
        if (predicate(value)) {
            results.push(value);
        }
    } catch {}

    if (Array.isArray(value)) {
        for (const item of value) {
            deepFindObjects(item, predicate, results, seen);
        }
    } else {
        for (const key of Object.keys(value)) {
            deepFindObjects(
                value[key],
                predicate,
                results,
                seen
            );
        }
    }

    return results;
}

// ------------------------------------------------------------
// استخراج روابط الإعلانات من HTML
// ------------------------------------------------------------

function extractPropertyLinks(html) {
    const links = new Map();

    if (!html) return links;

    // الطريقة الأولى: HTML links
    const regex =
        /href=["']([^"']*\/property\/[^"']+)["']/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        const url = absoluteUrl(match[1]);

        const id = extractIdFromUrl(
            url.replace(/[?#].*$/, '')
        );

        if (id) {
            links.set(id, url);
        }
    }

    // الطريقة الثانية: أي نص يحتوي /property/
    const propertyRegex =
        /(?:https?:\/\/wasalt\.sa)?\/ar\/[^"'\\\s<>]*\/property\/[^"'\\\s<>]+/gi;

    while ((match = propertyRegex.exec(html)) !== null) {
        const url = absoluteUrl(match[0]);

        const id = extractIdFromUrl(
            url.replace(/[?#].*$/, '')
        );

        if (id) {
            links.set(id, url);
        }
    }

    return links;
}

// ------------------------------------------------------------
// استخراج الإعلان من object
// ------------------------------------------------------------

function propertyFromObject(obj, fallbackUrl = '') {
    if (!obj || typeof obj !== 'object') {
        return null;
    }

    const info =
        obj.property_info ||
        obj.propertyInfo ||
        obj.property ||
        obj;

    const id = firstValue(
        info.id,
        obj.id,
        obj.property_id,
        obj.propertyId
    );

    if (!id) return null;

    const price = firstValue(
        info.price,
        info.amount,
        info.property_price,
        obj.price,
        obj.amount
    );

    const title = firstValue(
        info.title,
        info.name,
        info.property_title,
        obj.title,
        obj.name
    );

    const district = firstValue(
        info.district,
        info.district_name,
        info.neighborhood,
        info.neighborhood_name,
        obj.district,
        obj.district_name
    );

    const cityName = firstValue(
        info.city,
        info.city_name,
        obj.city,
        obj.city_name,
        city
    );

    const area = firstValue(
        info.area,
        info.area_size,
        info.space,
        info.size,
        obj.area,
        obj.area_size
    );

    const bedrooms = firstValue(
        info.bedrooms,
        info.bedroom,
        info.rooms,
        obj.bedrooms,
        obj.rooms
    );

    const bathrooms = firstValue(
        info.bathrooms,
        info.bathroom,
        obj.bathrooms
    );

    const image = firstValue(
        info.image,
        info.image_url,
        info.cover_image,
        info.main_image,
        obj.image,
        obj.image_url
    );

    const url = firstValue(
        info.url,
        info.link,
        obj.url,
        obj.link,
        fallbackUrl
    );

    return {
        id: String(id),
        url: absoluteUrl(url),
        title: cleanText(title),
        price,
        city: cleanText(cityName),
        district: cleanText(district),
        area,
        bedrooms,
        bathrooms,
        image: absoluteUrl(image),
    };
}

// ------------------------------------------------------------
// استخراج الإعلانات من __NEXT_DATA__
// ------------------------------------------------------------

function extractPropertiesFromNextData(nextData) {
    const properties = [];

    if (!nextData) return properties;

    const objects = deepFindObjects(
        nextData,
        (obj) => {
            if (!obj || typeof obj !== 'object') {
                return false;
            }

            const hasId =
                obj.id !== undefined ||
                obj.property_id !== undefined ||
                obj.propertyId !== undefined;

            const looksLikeProperty =
                obj.property_info ||
                obj.propertyInfo ||
                obj.property_type ||
                obj.propertyType ||
                obj.property_title ||
                obj.price;

            return Boolean(hasId && looksLikeProperty);
        }
    );

    for (const obj of objects) {
        const item = propertyFromObject(obj);

        if (!item) continue;

        if (!item.url) {
            item.url =
                `https://wasalt.sa/ar/${listingType}/property/${item.id}`;
        }

        properties.push(item);
    }

    return properties;
}

// ------------------------------------------------------------
// استخراج بيانات الإعلان من صفحة التفاصيل
// ------------------------------------------------------------

function parsePropertyDetails(html, url) {
    const result = {
        url,
        id: extractIdFromUrl(url),

        title: '',
        price: '',
        city: city,
        district: '',
        address: '',

        area: '',
        bedrooms: '',
        bathrooms: '',

        phone: '',
        owner: '',

        rega: '',
        verified: false,

        postedAt: '',
        updatedAt: '',

        image: '',
        images: [],

        description: '',
    };

    if (!html) {
        return result;
    }

    // --------------------------------------------------------
    // استخراج NEXT DATA
    // --------------------------------------------------------

    const nextData = extractNextData(html);

    let propertyObj = null;

    if (nextData) {
        const candidates = deepFindObjects(
            nextData,
            (obj) =>
                obj &&
                typeof obj === 'object' &&
                (
                    obj.property_info &&
                    (
                        obj.property_info.id ||
                        obj.property_info.property_id
                    )
                )
        );

        if (candidates.length) {
            propertyObj = candidates[0];
        }
    }

    if (!propertyObj && nextData) {
        const candidates = deepFindObjects(
            nextData,
            (obj) =>
                obj &&
                typeof obj === 'object' &&
                (
                    obj.propertyInfo &&
                    (
                        obj.propertyInfo.id ||
                        obj.propertyInfo.property_id
                    )
                )
        );

        if (candidates.length) {
            propertyObj = candidates[0];
        }
    }

    if (propertyObj) {
        const info =
            propertyObj.property_info ||
            propertyObj.propertyInfo ||
            propertyObj;

        const owner =
            propertyObj.owner ||
            info.owner ||
            {};

        const rega =
            propertyObj.rega ||
            propertyObj.rega_info ||
            propertyObj.rega_raw_info ||
            info.rega ||
            {};

        result.id = String(
            firstValue(
                info.id,
                info.property_id,
                propertyObj.id,
                result.id
            )
        );

        result.title = cleanText(
            firstValue(
                info.title,
                info.name,
                info.property_title
            )
        );

        result.price = firstValue(
            info.price,
            info.amount,
            info.property_price
        );

        result.city = cleanText(
            firstValue(
                info.city,
                info.city_name,
                propertyObj.city,
                city
            )
        );

        result.district = cleanText(
            firstValue(
                info.district,
                info.district_name,
                info.neighborhood,
                info.neighborhood_name
            )
        );

        result.address = cleanText(
            firstValue(
                info.address,
                info.location,
                info.full_address
            )
        );

        result.area = firstValue(
            info.area,
            info.area_size,
            info.space,
            info.size
        );

        result.bedrooms = firstValue(
            info.bedrooms,
            info.bedroom,
            info.rooms
        );

        result.bathrooms = firstValue(
            info.bathrooms,
            info.bathroom
        );

        result.phone = normalizePhone(
            firstValue(
                rega.phone_number,
                rega.responsible_employee_phone_number,
                owner.mobile,
                owner.phone,
                propertyObj.phone,
                propertyObj.mobile,
                info.phone,
                info.mobile
            )
        );

        result.owner = cleanText(
            firstValue(
                owner.name,
                owner.full_name,
                propertyObj.owner_name,
                info.owner_name
            )
        );

        result.rega = firstValue(
            rega.license_number,
            rega.license,
            rega.rega_license,
            propertyObj.rega_license,
            info.rega_license
        );

        result.verified =
            Boolean(
                firstValue(
                    propertyObj.verified,
                    propertyObj.is_verified,
                    info.verified,
                    info.is_verified
                )
            );

        result.postedAt = firstValue(
            info.created_at,
            info.createdAt,
            info.posted_at,
            info.postedAt,
            propertyObj.created_at,
            propertyObj.createdAt
        );

        result.updatedAt = firstValue(
            info.updated_at,
            info.updatedAt,
            propertyObj.updated_at,
            propertyObj.updatedAt
        );

        result.description = cleanText(
            firstValue(
                info.description,
                propertyObj.description
            )
        );

        result.image = absoluteUrl(
            firstValue(
                info.image,
                info.image_url,
                info.cover_image,
                info.main_image
            )
        );

        // الصور
        const imageCandidates = [
            ...(Array.isArray(info.images) ? info.images : []),
            ...(Array.isArray(propertyObj.images)
                ? propertyObj.images
                : []),
        ];

        for (const image of imageCandidates) {
            const imageUrl =
                typeof image === 'string'
                    ? image
                    : firstValue(
                        image?.url,
                        image?.src,
                        image?.image_url
                    );

            if (imageUrl) {
                result.images.push(
                    absoluteUrl(imageUrl)
                );
            }
        }
    }

    // --------------------------------------------------------
    // استخراج الهاتف من HTML مباشرة
    // --------------------------------------------------------

    if (!result.phone) {
        result.phone = extractPhone(
            html
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        );
    }

    // --------------------------------------------------------
    // استخراج tel:
    // --------------------------------------------------------

    if (!result.phone) {
        const telMatch = html.match(
            /href=["']tel:([^"']+)["']/i
        );

        if (telMatch) {
            result.phone = normalizePhone(
                telMatch[1]
            );
        }
    }

    // --------------------------------------------------------
    // استخراج العنوان من title / meta
    // --------------------------------------------------------

    if (!result.title) {
        const titleMatch = html.match(
            /<title[^>]*>([\s\S]*?)<\/title>/i
        );

        if (titleMatch) {
            result.title = cleanText(
                titleMatch[1]
            );
        }
    }

    // --------------------------------------------------------
    // استخراج description من meta
    // --------------------------------------------------------

    if (!result.description) {
        const descriptionMatch = html.match(
            /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
        );

        if (descriptionMatch) {
            result.description = cleanText(
                descriptionMatch[1]
            );
        }
    }

    // --------------------------------------------------------
    // تاريخ من HTML
    // --------------------------------------------------------

    if (!result.postedAt) {
        const dateMatch = html.match(
            /(?:نشر|تاريخ|posted|created)[^<]{0,100}?(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i
        );

        if (dateMatch) {
            result.postedAt = dateMatch[1];
        }
    }

    // --------------------------------------------------------
    // إزالة التكرار من الصور
    // --------------------------------------------------------

    result.images = [
        ...new Set(
            result.images.filter(Boolean)
        )
    ];

    if (
        result.image &&
        !result.images.includes(result.image)
    ) {
        result.images.unshift(result.image);
    }

    return result;
}

// ------------------------------------------------------------
// استخراج بيانات البطاقات من الصفحة
// ------------------------------------------------------------

async function extractCardsFromPage(page) {
    return await page.evaluate(() => {
        const output = [];

        const links = Array.from(
            document.querySelectorAll(
                'a[href*="/property/"]'
            )
        );

        for (const link of links) {
            const href = link.href;

            if (!href) continue;

            const match =
                href.match(/-(\d+)(?:\/)?$/);

            if (!match) continue;

            const id = match[1];

            const text = (
                link.innerText ||
                link.textContent ||
                ''
            )
                .replace(/\s+/g, ' ')
                .trim();

            const image =
                link.querySelector('img')?.src ||
                link.querySelector('img')?.getAttribute(
                    'data-src'
                ) ||
                '';

            output.push({
                id,
                url: href,
                text,
                image,
            });
        }

        return output;
    });
}

// ------------------------------------------------------------
// تشغيل متصفح البحث
// ------------------------------------------------------------

const searchUrl =
    `https://wasalt.sa/ar/${listingType}/search` +
    `?cityId=${cityId}` +
    `&countryId=1` +
    `&propertyFor=${listingType}` +
    `&type=${propertyType}`;

log.info(`🔎 Search URL: ${searchUrl}`);

// ------------------------------------------------------------
// Crawler البحث
// ------------------------------------------------------------

const crawler = new PlaywrightCrawler({
    proxyConfiguration,

    maxConcurrency: 1,

    maxRequestsPerCrawl: 1,

    requestHandlerTimeoutSecs: 120,

    navigationTimeoutSecs: 45,

    launchContext: {
        launchOptions: {
            headless: true,
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            // منع الملفات غير الضرورية لتسريع البحث
            await page.route(
                '**/*',
                async (route) => {
                    const type =
                        route.request().resourceType();

                    if (
                        type === 'font' ||
                        type === 'media'
                    ) {
                        return route.abort();
                    }

                    await route.continue();
                }
            );
        },
    ],

    requestHandler: async ({ page, request }) => {
        log.info('🌐 فتح صفحة البحث...');

        await page.goto(
            request.url,
            {
                waitUntil: 'domcontentloaded',
                timeout: 45000,
            }
        );

        // ننتظر ظهور أول إعلان
        try {
            await page.waitForSelector(
                'a[href*="/property/"]',
                {
                    timeout: 15000,
                }
            );
        } catch {
            log.warning(
                '⚠️ لم يظهر إعلان مباشرة، سنحاول المتابعة'
            );
        }

        // ----------------------------------------------------
        // جمع الإعلانات الموجودة
        // ----------------------------------------------------

        let lastCount = 0;
        let stableRounds = 0;

        for (let i = 0; i < 6; i++) {
            const cards =
                await extractCardsFromPage(page);

            for (const card of cards) {
                if (!discoveredIds.has(card.id)) {
                    discoveredIds.add(card.id);

                    finalItems.set(
                        card.id,
                        {
                            id: card.id,
                            url: card.url,
                            title: '',
                            price: '',
                            city,
                            district: '',
                            address: '',
                            area: '',
                            bedrooms: '',
                            bathrooms: '',
                            phone: '',
                            owner: '',
                            rega: '',
                            verified: false,
                            postedAt: '',
                            updatedAt: '',
                            image: card.image || '',
                            images: [],
                            description: '',
                        }
                    );
                }
            }

            log.info(
                `📦 تم اكتشاف ${discoveredIds.size} إعلان`
            );

            if (
                discoveredIds.size >=
                Number(maxResults)
            ) {
                break;
            }

            if (
                discoveredIds.size ===
                lastCount
            ) {
                stableRounds++;
            } else {
                stableRounds = 0;
            }

            lastCount = discoveredIds.size;

            if (stableRounds >= 2) {
                break;
            }

            // Scroll صغير بدل الانتظار الطويل
            await page.evaluate(() => {
                window.scrollTo(
                    0,
                    document.body.scrollHeight
                );
            });

            await page.waitForTimeout(900);
        }

        // ----------------------------------------------------
        // محاولة أخذ البيانات من NEXT DATA
        // ----------------------------------------------------

        const html = await page.content();

        const nextData =
            extractNextData(html);

        const nextProperties =
            extractPropertiesFromNextData(
                nextData
            );

        for (const property of nextProperties) {
            if (!property.id) continue;

            if (
                !discoveredIds.has(
                    property.id
                )
            ) {
                discoveredIds.add(
                    property.id
                );
            }

            const existing =
                finalItems.get(property.id) || {};

            finalItems.set(
                property.id,
                {
                    ...existing,
                    ...property,
                    id: property.id,
                    url:
                        property.url ||
                        existing.url ||
                        `https://wasalt.sa/ar/${listingType}/property/${property.id}`,
                }
            );
        }

        searchFinished = true;
    },
});

// ------------------------------------------------------------
// بدء البحث
// ------------------------------------------------------------

await crawler.run([
    {
        url: searchUrl,
        uniqueKey: `wasalt-search-${Date.now()}`,
    },
]);

log.info(
    `🔍 انتهى البحث. إجمالي الإعلانات: ${finalItems.size}`
);

// ------------------------------------------------------------
// تحديد أول maxResults
// ------------------------------------------------------------

const itemsToProcess =
    Array.from(finalItems.values())
        .slice(0, Number(maxResults));

// ------------------------------------------------------------
// HTTP detail crawler
// ------------------------------------------------------------
//
// نستخدم Playwright request بدل فتح صفحة كاملة.
// هذا أسرع بكثير من page.goto لكل إعلان.
// ------------------------------------------------------------

async function fetchDetailHtml(url) {
    try {
        const response =
            await fetch(url, {
                method: 'GET',
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language':
                        'ar-SA,ar;q=0.9,en;q=0.8',
                },
            });

        if (!response.ok) {
            return '';
        }

        return await response.text();
    } catch (error) {
        log.warning(
            `HTTP detail failed: ${error.message}`
        );

        return '';
    }
}

// ------------------------------------------------------------
// معالجة إعلان واحد
// ------------------------------------------------------------

async function processItem(item) {
    const url = item.url;

    if (!url) {
        return item;
    }

    log.info(
        `📄 معالجة الإعلان ${item.id}`
    );

    // --------------------------------------------------------
    // أول محاولة: HTTP
    // --------------------------------------------------------

    const html =
        await fetchDetailHtml(url);

    if (html) {
        const details =
            parsePropertyDetails(
                html,
                url
            );

        item = {
            ...item,
            ...details,

            id:
                details.id ||
                item.id,

            url:
                details.url ||
                item.url,

            image:
                details.image ||
                item.image,
        };
    }

    // --------------------------------------------------------
    // إذا لم نجد الهاتف، نستخدم Browser
    // فقط لهذا الإعلان
    // --------------------------------------------------------

    if (!item.phone) {
        log.info(
            `📱 الهاتف غير موجود HTTP — محاولة Browser: ${item.id}`
        );

        try {
            const phoneCrawler =
                new PlaywrightCrawler({
                    proxyConfiguration,

                    maxConcurrency: 1,

                    maxRequestsPerCrawl: 1,

                    requestHandlerTimeoutSecs: 60,

                    navigationTimeoutSecs: 30,

                    launchContext: {
                        launchOptions: {
                            headless: true,
                        },
                    },

                    preNavigationHooks: [
                        async ({ page }) => {
                            await page.route(
                                '**/*',
                                async (route) => {
                                    const type =
                                        route.request().resourceType();

                                    if (
                                        type === 'image' ||
                                        type === 'font' ||
                                        type === 'media' ||
                                        type === 'stylesheet'
                                    ) {
                                        return route.abort();
                                    }

                                    await route.continue();
                                }
                            );
                        },
                    ],

                    requestHandler:
                        async ({ page }) => {
                            await page.goto(
                                url,
                                {
                                    waitUntil:
                                        'domcontentloaded',
                                    timeout: 30000,
                                }
                            );

                            // محاولة سريعة من DOM
                            let phone =
                                await page.evaluate(() => {
                                    const text =
                                        document.body?.innerText ||
                                        '';

                                    const matches =
                                        text.match(
                                            /(?:\+?966[\s-]?)?05\d{8}/g
                                        ) ||
                                        text.match(
                                            /(?:\+?966[\s-]?)?5\d{8}/g
                                        );

                                    if (
                                        matches &&
                                        matches.length
                                    ) {
                                        return matches[0];
                                    }

                                    const tel =
                                        document.querySelector(
                                            'a[href^="tel:"]'
                                        );

                                    if (tel) {
                                        return tel.href
                                            .replace(
                                                /^tel:/i,
                                                ''
                                            );
                                    }

                                    return '';
                                });

                            phone =
                                normalizePhone(
                                    phone
                                );

                            if (phone) {
                                item.phone = phone;
                            }

                            // محاولة إضافية من HTML
                            if (!item.phone) {
                                const html =
                                    await page.content();

                                item.phone =
                                    extractPhone(
                                        html
                                    );
                            }
                        },
                });

            await phoneCrawler.run([
                {
                    url,
                    uniqueKey:
                        `phone-${item.id}-${Date.now()}`,
                },
            ]);
        } catch (error) {
            log.warning(
                `⚠️ فشل استخراج الهاتف ${item.id}: ${error.message}`
            );
        }
    }

    return item;
}

// ------------------------------------------------------------
// معالجة بالتوازي
// ------------------------------------------------------------

const concurrency = 3;

for (
    let i = 0;
    i < itemsToProcess.length;
    i += concurrency
) {
    const batch =
        itemsToProcess.slice(
            i,
            i + concurrency
        );

    const results =
        await Promise.all(
            batch.map(
                (item) =>
                    processItem(item)
            )
        );

    for (const result of results) {
        finalItems.set(
            result.id,
            result
        );

        // ----------------------------------------------------
        // تنظيف النتيجة
        // ----------------------------------------------------

        const output = {
            id: result.id || '',
            url: result.url || '',

            title:
                cleanText(result.title),

            price:
                result.price || '',

            city:
                cleanText(result.city),

            district:
                cleanText(result.district),

            address:
                cleanText(result.address),

            area:
                result.area || '',

            bedrooms:
                result.bedrooms || '',

            bathrooms:
                result.bathrooms || '',

            phone:
                normalizePhone(result.phone),

            owner:
                cleanText(result.owner),

            rega:
                result.rega || '',

            verified:
                Boolean(result.verified),

            postedAt:
                result.postedAt || '',

            updatedAt:
                result.updatedAt || '',

            image:
                result.image || '',

            images:
                result.images || [],

            description:
                cleanText(result.description),

            source:
                'wasalt.sa',

            scrapedAt:
                new Date().toISOString(),
        };

        await Actor.pushData(output);

        log.info(
            `✅ تم حفظ ${result.id} | الهاتف: ${output.phone || 'غير متوفر'}`
        );
    }
}

// ------------------------------------------------------------
// Webhook
// ------------------------------------------------------------

if (webhookUrl) {
    try {
        const datasetId =
            await Actor.getEnv()
                .then((env) => env.defaultDatasetId);

        const datasetUrl =
            `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true`;

        await fetch(
            webhookUrl,
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json',
                },

                body: JSON.stringify({
                    success: true,

                    source: 'wasalt.sa',

                    city,

                    cityId,

                    listingType,

                    propertyType,

                    count:
                        itemsToProcess.length,

                    datasetId,

                    datasetUrl,

                    finishedAt:
                        new Date().toISOString(),
                }),
            }
        );

        log.info(
            '📡 تم إرسال Webhook بنجاح'
        );
    } catch (error) {
        log.warning(
            `⚠️ فشل Webhook: ${error.message}`
        );
    }
}

// ------------------------------------------------------------
// النهاية
// ------------------------------------------------------------

log.info(
    `🎯 اكتمل أكتور Wasalt — ${itemsToProcess.length} إعلان`
);

await Actor.exit();
