// listing/book.ts - WITH POPULATE AT ROOT RESPONSE LEVEL

import { Request, Response } from "express";
import admin from "firebase-admin";

const db = admin.firestore();
const BOOKING_COLLECTION = 'booking';
const SERVICES_COLLECTION = 'services';
const USERS_COLLECTION = 'users';

// ============================================================
// INTERFACES
// ============================================================

interface UserData {
    uid?: string;
    name?: string;
    email?: string;
    phone?: string;
    avatar?: string;
    role?: string;
    createdAt?: string;
}

interface CartItemShort {
    service_id: string;
    variant_id: string;
    selected_options?: { [optionId: string]: string };
}

interface CartModelShort {
    id?: string;
    client_id?: string;
    payment_id?: string;
    refund_id?: string;
    vendor_id?: string;
    created_at?: string;
    status?: string;
    is_admin_decision?: boolean;
    items: CartItemShort[];
    total_amount?: number;
    book_datetime?: string | admin.firestore.Timestamp;
    duration?: number;
    formatted_duration?: string;
    [key: string]: any;
}

interface Choice {
    id: string;
    name: string;
    price: number;
}

interface Option {
    id: string;
    name: string;
    choices: Choice[];
    selected_choice?: Choice | null;
    selected_choice_id?: string | null;
}

interface ServiceVariant {
    id: string;
    name: string;
    price: number;
    durationValue?: number;
    durationUnit?: string;
    duration_value?: number;
    duration_unit?: string;
    duration?: number;
    formatted_duration?: string;
    options: Option[];
    [key: string]: any;
}

interface ServiceModel {
    id?: string;
    name: string;
    description: string;
    category_id?: string;
    vendor_id?: string;
    variants: ServiceVariant[];
    images?: string[];
    is_active?: boolean;
    created_at?: string;
    updated_at?: string;
    [key: string]: any;
}

interface CartModel {
    id?: string;
    client_id?: string;
    vendor_id?: string;
    payment_id?: string;
    refund_id?: string;
    created_at?: string;
    status?: string;
    items: ServiceModel[];
    client?: UserData;
    payement?: any;
    refund?: any;
    vendor?: UserData;
    book_datetime?: string;
    is_admin_decision?: boolean;
    duration?: number;
    formatted_duration?: string;
    [key: string]: any;
}

interface GroupedBookings {
    past: CartModel[];
    today: CartModel[];
    future: CartModel[];
}

/**
 * ✅ Populate configuration supporting root, items, and response levels
 *
 * @example Root level: { from: 'vendors', id: 'vendor_id' }
 * @example Items level: { from: 'categories', id: 'category_id', path: 'items' }
 * @example Response level: { from: 'clients', id: 'id', path: 'response', as: 'primaryUser' }
 */
interface PopulateConfig {
    from: string;           // Collection name to fetch from
    id: string;             // Field containing the ID to lookup
    fields?: string[];      // Fields to return (undefined = all)
    as?: string;            // Field name for populated data (defaults to collection name)
    path?: string;          // Path in nested structure ('items', 'items.variants', 'response')
}

interface BookingListResponse {
    success: boolean;
    data: {
        bookings: CartModel[];
        grouped?: GroupedBookings;
        count: number;
        mode: string;
        id: string;
        expanded: boolean;
        hasMore: boolean;
        nextCursor?: string;
        totalCount?: number;
        groupBy?: string;
        [key: string]: any;  // For response-level populated data
    };
    error?: string;
    message?: string;
}

// ============================================================
// DURATION HELPERS
// ============================================================

function convertToMinutes(value: number | undefined, unit: string | undefined): number {
    if (!value || !unit) return 0;

    const unitLower = unit.toLowerCase();

    if (['minute', 'minutes', 'min'].includes(unitLower)) {
        return value;
    }
    if (['hour', 'hours', 'heure', 'heures', 'h'].includes(unitLower)) {
        return value * 60;
    }
    if (['day', 'days', 'jour', 'jours', 'j'].includes(unitLower)) {
        return value * 60 * 24;
    }

    return value;
}

function formatDuration(totalMinutes: number): string {
    if (totalMinutes <= 0) {
        return '0 min';
    }

    if (totalMinutes < 60) {
        return `${totalMinutes} min`;
    }

    if (totalMinutes < 1440) {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        if (minutes === 0) {
            return `${hours} h`;
        }
        return `${hours} h ${minutes} min`;
    }

    const days = Math.floor(totalMinutes / 1440);
    const remainingHours = Math.floor((totalMinutes % 1440) / 60);

    if (remainingHours === 0) {
        return `${days} jour${days > 1 ? 's' : ''}`;
    }

    return `${days} jour${days > 1 ? 's' : ''} ${remainingHours} h`;
}

function calculateCartDuration(items: ServiceModel[]): {
    duration: number;
    formatted_duration: string
} {
    let totalMinutes = 0;

    for (const service of items) {
        for (const variant of service.variants || []) {
            const variantDuration = convertToMinutes(
                (variant as any).durationValue,
                (variant as any).durationUnit
            );
            totalMinutes += variantDuration;
        }
    }

    return {
        duration: totalMinutes,
        formatted_duration: formatDuration(totalMinutes),
    };
}

function enrichVariantWithDuration(variant: ServiceVariant): ServiceVariant {
    const durationMinutes = convertToMinutes(
        (variant as any).durationValue,
        (variant as any).durationUnit
    );

    return {
        ...variant,
        duration: durationMinutes,
        formatted_duration: formatDuration(durationMinutes),
    };
}

// ============================================================
// HELPER: Convert Firestore Timestamp to ISO String
// ============================================================

function convertToISOString(value: any): string {
    if (!value) return '';

    if (value instanceof admin.firestore.Timestamp) {
        return value.toDate().toISOString();
    }

    if (typeof value === 'string') {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    try {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
            return date.toISOString();
        }
    } catch (error) {
        console.error('Failed to convert value to date:', value, error);
    }

    return '';
}

// ============================================================
// POPULATE FEATURE (ROOT, ITEMS, VARIANTS, & RESPONSE)
// ============================================================

/**
 * ✅ Populate relation from another collection
 */
async function populateRelation(docId: string | undefined, config: PopulateConfig): Promise<any> {
    if (!docId) {
        return null;
    }

    try {
        console.log(`   📎 Populating ${config.from} for ID: ${docId}`);

        const doc = await db.collection(config.from).doc(docId).get();

        if (!doc.exists) {
            console.warn(`   ⚠️ Document not found in ${config.from}: ${docId}`);
            return null;
        }

        let data = doc.data();

        // Filter fields if specified
        if (config.fields && config.fields.length > 0) {
            const filteredData: any = { id: doc.id };
            for (const field of config.fields) {
                if (field in data!) {
                    filteredData[field] = data![field];
                }
            }
            data = filteredData;
        } else {
            data!.id = doc.id;
        }

        return data;

    } catch (error) {
        console.error(`   ❌ Error populating ${config.from}:`, error);
        return null;
    }
}

/**
 * ✅ Populate relation in nested object/array
 */
async function populateInPath(data: any, config: PopulateConfig): Promise<any> {
    if (!config.path) {
        return data;
    }

    const pathParts = config.path.split('.');
    const fieldName = config.id;
    const asName = config.as || config.from;

    console.log(`   📎 Populating ${config.from} in path: ${config.path}`);

    // Handle 'items' path
    if (pathParts[0] === 'items' && Array.isArray(data.items)) {
        if (pathParts.length === 1) {
            // Populate at items level
            for (const item of data.items) {
                const docId = item[fieldName];
                if (docId) {
                    const populatedData = await populateRelation(docId, config);
                    if (populatedData) {
                        item[asName] = populatedData;
                    }
                }
            }
        } else if (pathParts[1] === 'variants') {
            // Populate at items.variants level
            for (const item of data.items) {
                if (Array.isArray(item.variants)) {
                    for (const variant of item.variants) {
                        const docId = variant[fieldName];
                        if (docId) {
                            const populatedData = await populateRelation(docId, config);
                            if (populatedData) {
                                variant[asName] = populatedData;
                            }
                        }
                    }
                }
            }
        }
    }

    return data;
}

/**
 * ✅ Populate relation at response data level
 * Special handling for response-level populate
 */
async function populateResponseLevel(
    responseData: any,
    config: PopulateConfig,
    mode: string,
    userId: string
): Promise<any> {
    if (config.path !== 'response') {
        return responseData;
    }

    const asName = config.as || config.from;

    // If ID field is 'id', use the userId (mode-based)
    let docId = config.id === 'id' ? userId : (responseData as any)[config.id];

    if (!docId) {
        console.warn(`   ⚠️ No ID found for response-level populate: ${config.id}`);
        return responseData;
    }

    console.log(`   📎 Populating ${config.from} at response level (ID: ${docId})`);

    const populatedData = await populateRelation(docId, config);
    if (populatedData) {
        (responseData as any)[asName] = populatedData;
    }

    return responseData;
}

/**
 * ✅ Apply multiple population configs
 * Supports root, items, variants, and response levels
 */
async function populateBooking(
    booking: CartModel,
    populateConfigs: PopulateConfig[] | undefined
): Promise<CartModel> {
    if (!populateConfigs || populateConfigs.length === 0) {
        return booking;
    }

    for (const config of populateConfigs) {
        try {
            if (config.path === 'response') {
                // Skip response-level configs here
                continue;
            } else if (config.path) {
                // Populate in nested path (items, items.variants, etc)
                booking = await populateInPath(booking, config);
            } else {
                // Populate at root level
                const fieldName = config.id;
                const docId = (booking as any)[fieldName];
                const asName = config.as || config.from;

                if (!docId) {
                    console.warn(`   ⚠️ Field "${fieldName}" not found in booking`);
                    continue;
                }

                const populatedData = await populateRelation(docId, config);
                if (populatedData) {
                    (booking as any)[asName] = populatedData;
                }
            }
        } catch (error) {
            console.error(`Error applying populate config for ${config.from}:`, error);
        }
    }

    return booking;
}

/**
 * ✅ Apply response-level populate configs
 */
async function populateResponseData(
    responseData: any,
    populateConfigs: PopulateConfig[] | undefined,
    mode: string,
    userId: string
): Promise<any> {
    if (!populateConfigs || populateConfigs.length === 0) {
        return responseData;
    }

    console.log(`   🔗 Applying response-level populate configs...`);

    for (const config of populateConfigs) {
        if (config.path === 'response') {
            responseData = await populateResponseLevel(responseData, config, mode, userId);
        }
    }

    return responseData;
}

// ============================================================
// HELPER: Date grouping functions
// ============================================================

function extractDateString(dateTimeStr: string): string {
    if (!dateTimeStr) return '';

    try {
        if (dateTimeStr.includes('T')) {
            return dateTimeStr.split('T')[0];
        }

        if (dateTimeStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            return dateTimeStr;
        }

        const date = new Date(dateTimeStr);
        if (!isNaN(date.getTime())) {
            return date.toISOString().split('T')[0];
        }
    } catch (error) {
        console.error('Failed to extract date string:', dateTimeStr, error);
    }

    return '';
}

function getTodayDateString(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function compareDateStrings(dateStr1: string, dateStr2: string): number {
    if (!dateStr1 || !dateStr2) return 0;

    if (dateStr1 < dateStr2) return -1;
    if (dateStr1 > dateStr2) return 1;
    return 0;
}

// ============================================================
// ENDPOINTS - ALL PUBLIC (NO AUTHENTICATION REQUIRED)
// ============================================================

/**
 * 🔓 PUBLIC ENDPOINT - No authorization required
 * Fetch booking detail by ID or expand cart data
 *
 * @body bookingId - (optional) Booking document ID to fetch
 * @body cartData - (optional) Cart data to expand
 * @body populate - (optional) Array of PopulateConfig objects for data enrichment
 */
export async function getBookingDetail(req: Request, res: Response) {
    try {
        const { bookingId, cartData, populate } = req.body;
        let shortCart: CartModelShort;

        if (bookingId) {
            console.log(`📖 Fetching booking: ${bookingId}`);

            const bookingDoc = await db
                .collection(BOOKING_COLLECTION)
                .doc(bookingId)
                .get();

            if (!bookingDoc.exists) {
                return res.status(404).json({
                    success: false,
                    error: `Booking not found: ${bookingId}`
                });
            }

            shortCart = bookingDoc.data() as CartModelShort;
            shortCart.id = bookingDoc.id;
        } else if (cartData) {
            shortCart = cartData as CartModelShort;
        } else {
            return res.status(400).json({
                success: false,
                error: 'Invalid request. Provide either "bookingId" or "cartData"'
            });
        }

        if (!shortCart.items || shortCart.items.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Cart has no items'
            });
        }

        let fullCart = await expandShortCart(shortCart);

        // ✅ Apply populate configs (root, items, variants)
        if (populate && Array.isArray(populate)) {
            fullCart = await populateBooking(fullCart, populate);
        }

        return res.status(200).json({
            success: true,
            data: fullCart
        });

    } catch (error: any) {
        console.error('Error expanding cart:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to expand cart',
            message: error.message
        });
    }
}

/**
 * 🔓 PUBLIC ENDPOINT - No authorization required
 * Fetch a single booking by ID with optional population
 *
 * @query bookingId - (required) Booking document ID
 * @query populate - (optional) JSON string of PopulateConfig array
 */
export async function getBookingDetailById(req: Request, res: Response) {
    try {
        const bookingId = req.query.bookingId as string;
        const populate = req.query.populate as string | undefined;

        if (!bookingId) {
            return res.status(400).json({
                success: false,
                error: 'Missing bookingId parameter'
            });
        }

        console.log(`📖 Fetching booking by ID: ${bookingId}`);

        const bookingDoc = await db
            .collection(BOOKING_COLLECTION)
            .doc(bookingId)
            .get();

        if (!bookingDoc.exists) {
            return res.status(404).json({
                success: false,
                error: `Booking not found: ${bookingId}`
            });
        }

        const shortCart = bookingDoc.data() as CartModelShort;
        shortCart.id = bookingDoc.id;

        let fullCart = await expandShortCart(shortCart);

        // ✅ Apply populate configs (root, items, variants, response)
        if (populate) {
            try {
                const populateConfigs: PopulateConfig[] = JSON.parse(populate);
                fullCart = await populateBooking(fullCart, populateConfigs);
            } catch (e) {
                console.warn('Invalid populate parameter:', e);
            }
        }

        const [clientData, vendorData] = await Promise.all([
            shortCart.client_id ? fetchUserData(shortCart.client_id) : Promise.resolve(undefined),
            shortCart.vendor_id ? fetchUserData(shortCart.vendor_id) : Promise.resolve(undefined),
        ]);

        fullCart.client = clientData ?? {};
        fullCart.vendor = vendorData ?? {};

        const [paymentData, refundData] = await Promise.all([
            shortCart.payment_id ? fetchPayData(shortCart.payment_id) : Promise.resolve(undefined),
            shortCart.refund_id ? fetchPayData(shortCart.refund_id) : Promise.resolve(undefined),
        ]);

        fullCart.refund = refundData ?? {};
        fullCart.payment = paymentData ?? {};

        return res.status(200).json({
            success: true,
            data: fullCart
        });

    } catch (error: any) {
        console.error('Error fetching booking detail:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch booking detail',
            message: error.message
        });
    }
}

/**
 * 🔓 PUBLIC ENDPOINT - No authorization required
 * Fetch bookings by mode (client or vendor) with pagination, filtering, and optional population
 *
 * @query/body mode - (required) 'client' or 'vendor'
 * @query/body id - (required) User ID (client_id or vendor_id)
 * @query/body expand - (optional) 'true' to expand services, 'false' to enrich with user data
 * @query/body status - (optional) Filter by booking status
 * @query/body cursor - (optional) Pagination cursor (Prioritized over page)
 * @query/body page - (optional) Page number (Default 1). Used if cursor is not provided.
 * @query/body limit - (optional) Results per page (1-100, default 10)
 * @query/body sortBy - (optional) Field to sort by (created_at, book_datetime, status)
 * @query/body sortOrder - (optional) 'asc' or 'desc'
 * @query/body groupBy - (optional) 'date' to group bookings by date
 * @query/body populate - (optional) JSON string of PopulateConfig array
 */
export async function getBookingsByMode(req: Request, res: Response): Promise<any> {
    try {
        const mode = (req.query.mode || req.body.mode) as string;
        const id = (req.query.id || req.body.id) as string;
        const expand = (req.query.expand || req.body.expand) === 'true';
        const status = (req.query.status || req.body.status) as string | undefined;

        // Pagination params
        const cursor = (req.query.cursor || req.body.cursor) as string | undefined;
        const page = Math.max(parseInt((req.query.page || req.body.page || '1') as string), 1);
        const limit = Math.min(parseInt((req.query.limit || req.body.limit || '10') as string), 100);

        let sortBy = (req.query.sortBy || req.body.sortBy) as string;
        const sortOrder = (req.query.sortOrder || req.body.sortOrder || 'desc') as 'asc' | 'desc';
        const groupBy = (req.query.groupBy || req.body.groupBy) as string | undefined;

        // ✅ Parse populate parameter
        let populateConfigs: PopulateConfig[] | undefined;
        const populateParam = req.query.populate || req.body.populate;
        if (populateParam) {
            try {
                populateConfigs = typeof populateParam === 'string'
                    ? JSON.parse(populateParam)
                    : populateParam;
            } catch (e) {
                console.warn('Invalid populate parameter:', e);
            }
        }

        if (groupBy === 'date') {
            sortBy = 'book_datetime';
            console.log(`   📅 Grouping by date detected - forcing sortBy: book_datetime`);
        } else {
            sortBy = sortBy || 'created_at';
        }

        if (!mode || (mode !== 'client' && mode !== 'vendor')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid mode. Must be "client" or "vendor"'
            });
        }

        if (!id) {
            return res.status(400).json({
                success: false,
                error: `Missing ${mode}_id parameter`
            });
        }

        if (limit < 1 || limit > 100) {
            return res.status(400).json({
                success: false,
                error: 'Limit must be between 1 and 100'
            });
        }

        const validSortFields = ['created_at', 'book_datetime', 'status'];
        const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'created_at';

        console.log(`\n🔍 Fetching bookings:`);
        console.log(`   Mode: ${mode}`);
        console.log(`   ID: ${id}`);
        console.log(`   Page: ${page}, Limit: ${limit}`);
        console.log(`   Populate configs: ${populateConfigs?.length || 0}`);

        const fieldName = mode === 'client' ? 'client_id' : 'vendor_id';

        let query = db
            .collection(BOOKING_COLLECTION)
            .where(fieldName, '==', id);

        if (status) {
            query = query.where('status', '==', status);
        }

        query = query.orderBy(finalSortBy, sortOrder);

        // ✅ Pagination Logic (Cursor vs Page)
        if (cursor) {
            try {
                const cursorDoc = await db
                    .collection(BOOKING_COLLECTION)
                    .doc(cursor)
                    .get();

                if (cursorDoc.exists) {
                    const cursorValue = cursorDoc.get(finalSortBy);
                    query = query.startAfter(cursorValue);
                }
            } catch (error) {
                console.warn('⚠️ Invalid cursor:', error);
            }
        } else if (page > 1) {
            // Only apply offset if no cursor is present and page > 1
            const offset = (page - 1) * limit;
            console.log(`   📄 Applying offset: ${offset}`);
            query = query.offset(offset);
        }

        const snapshot = await query.limit(limit + 1).get();

        if (snapshot.empty) {
            let responseData: any = {
                bookings: [],
                grouped: groupBy === 'date' ? { past: [], today: [], future: [] } : undefined,
                count: 0,
                mode,
                id,
                expanded: expand,
                hasMore: false,
                page, // Return page info
                nextCursor: undefined,
                totalCount: 0,
                groupBy: groupBy || undefined
            };

            // ✅ Apply response-level populate
            if (populateConfigs) {
                responseData = await populateResponseData(responseData, populateConfigs, mode, id);
            }

            return res.status(200).json({
                success: true,
                data: responseData
            } as BookingListResponse);
        }

        const docs = snapshot.docs;
        const hasMore = docs.length > limit;
        const bookingDocs = hasMore ? docs.slice(0, limit) : docs;

        const shortCarts: CartModelShort[] = bookingDocs.map(doc => {
            const data = doc.data() as CartModelShort;
            data.id = doc.id;
            return data;
        });

        const nextCursor = hasMore && bookingDocs.length > 0
            ? bookingDocs[bookingDocs.length - 1].id
            : undefined;

        if (expand) {
            console.log(`   📦 Expanding ${shortCarts.length} bookings...`);

            let expandedCarts: CartModel[] = [];

            for (const shortCart of shortCarts) {
                try {
                    let fullCart = await expandShortCart(shortCart);

                    // ✅ Apply populate configs (root, items, variants)
                    if (populateConfigs) {
                        fullCart = await populateBooking(fullCart, populateConfigs);
                    }

                    expandedCarts.push(fullCart);
                } catch (error) {
                    console.error(`❌ Error expanding booking ${shortCart.id}:`, error);
                }
            }

            let responseData: any = {
                bookings: expandedCarts,
                count: expandedCarts.length,
                mode,
                id,
                expanded: true,
                hasMore,
                page, // Return page info
                nextCursor,
                totalCount: expandedCarts.length,
                groupBy
            };

            if (groupBy === 'date') {
                const grouped = groupBookingsByBookDateTime(expandedCarts);
                responseData.grouped = grouped;
            }

            // ✅ Apply response-level populate
            if (populateConfigs) {
                responseData = await populateResponseData(responseData, populateConfigs, mode, id);
            }

            return res.status(200).json({
                success: true,
                data: responseData
            } as BookingListResponse);
        }

        console.log(`   👤 Enriching ${shortCarts.length} bookings...`);

        let enrichedBookings = await Promise.all(
            shortCarts.map(booking => enrichBookingWithUserData(booking))
        );

        // ✅ Apply populate configs to enriched bookings (root, items, variants)
        if (populateConfigs) {
            enrichedBookings = await Promise.all(
                enrichedBookings.map(booking => populateBooking(booking, populateConfigs))
            );
        }

        let responseData: any = {
            bookings: enrichedBookings,
            count: enrichedBookings.length,
            mode,
            id,
            expanded: false,
            hasMore,
            limit,
            page, // Return page info
            nextCursor,
            totalCount: enrichedBookings.length,
            groupBy
        };

        if (groupBy === 'date') {
            const grouped = groupBookingsByBookDateTime(enrichedBookings);
            responseData.grouped = grouped;
        }

        // ✅ Apply response-level populate
        if (populateConfigs) {
            responseData = await populateResponseData(responseData, populateConfigs, mode, id);
        }

        return res.status(200).json({
            success: true,
            data: responseData
        } as BookingListResponse);

    } catch (error: any) {
        console.error('Error fetching bookings by mode:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch bookings',
            message: error.message
        });
    }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function groupBookingsByBookDateTime(bookings: CartModel[]): GroupedBookings {
    const todayStr = getTodayDateString();

    const grouped: GroupedBookings = {
        past: [],
        today: [],
        future: [],
    };

    for (const booking of bookings) {
        if (!booking.book_datetime) continue;

        try {
            const bookingDateStr = extractDateString(booking.book_datetime);

            if (!bookingDateStr) continue;

            const comparison = compareDateStrings(bookingDateStr, todayStr);

            if (comparison < 0) {
                grouped.past.push(booking);
            } else if (comparison === 0) {
                grouped.today.push(booking);
            } else {
                grouped.future.push(booking);
            }
        } catch (error) {
            console.error(`Error processing booking ${booking.id}:`, error);
        }
    }

    return grouped;
}

async function fetchUserData(userId: string): Promise<UserData | null> {
    try {
        if (!userId) return null;

        const userDoc = await db
            .collection(USERS_COLLECTION)
            .doc(userId)
            .get();

        if (!userDoc.exists) {
            return null;
        }

        const userData = userDoc.data() as UserData;
        userData.uid = userDoc.id;

        return userData;

    } catch (error) {
        console.error(`Error fetching user ${userId}:`, error);
        return null;
    }
}

async function fetchPayData(userId: string): Promise<UserData | null> {
    try {
        if (!userId) return null;

        const userDoc = await db
            .collection("payments")
            .doc(userId)
            .get();

        if (!userDoc.exists) {
            return null;
        }

        const userData = userDoc.data() as any;
        userData.uid = userDoc.id;

        return userData;

    } catch (error) {
        console.error(`Error fetching user ${userId}:`, error);
        return null;
    }
}

async function enrichBookingWithUserData(
    booking: CartModelShort
): Promise<CartModel> {
    const fullCart = await expandShortCart(booking);

    const [clientData, vendorData] = await Promise.all([
        booking.client_id ? fetchUserData(booking.client_id) : Promise.resolve(null),
        booking.vendor_id ? fetchUserData(booking.vendor_id) : Promise.resolve(null),
    ]);

    return {
        ...fullCart,
        client: clientData || undefined,
        vendor: vendorData || undefined,
    };
}

async function expandShortCart(shortCart: CartModelShort): Promise<CartModel> {
    const fullServices: ServiceModel[] = [];

    const bookDateTimeStr = convertToISOString(shortCart.book_datetime);

    if (!shortCart.items || shortCart.items.length === 0) {
        return {
            ...shortCart,
            items: [],
            book_datetime: bookDateTimeStr,
            duration: 0,
            formatted_duration: '0 min',
        };
    }

    const serviceGroups = new Map<string, CartItemShort[]>();

    for (const item of shortCart.items) {
        if (!item.service_id) continue;

        if (!serviceGroups.has(item.service_id)) {
            serviceGroups.set(item.service_id, []);
        }
        serviceGroups.get(item.service_id)!.push(item);
    }

    for (const [serviceId, cartItems] of serviceGroups.entries()) {
        try {
            const serviceDoc = await db
                .collection(SERVICES_COLLECTION)
                .doc(serviceId)
                .get();

            if (!serviceDoc.exists) continue;

            const serviceData = serviceDoc.data() as ServiceModel;
            serviceData.id = serviceDoc.id;

            const selectedVariants: ServiceVariant[] = [];

            for (const cartItem of cartItems) {
                if (!cartItem.variant_id) continue;

                const variant = serviceData.variants.find(v => v.id === cartItem.variant_id);

                if (!variant) continue;

                const configuredVariant = configureVariantOptions(
                    variant,
                    cartItem.selected_options || {}
                );

                const variantWithDuration = enrichVariantWithDuration(configuredVariant);

                selectedVariants.push(variantWithDuration);
            }

            if (selectedVariants.length > 0) {
                const serviceWithVariants: ServiceModel = {
                    id: serviceData.id,
                    name: serviceData.name,
                    description: serviceData.description,
                    category_id: serviceData.category_id,
                    vendor_id: serviceData.vendor_id,
                    variants: selectedVariants,
                    images: serviceData.images,
                    is_active: serviceData.is_active,
                    created_at: serviceData.created_at,
                    updated_at: serviceData.updated_at,
                };

                fullServices.push(serviceWithVariants);
            }

        } catch (error) {
            console.error(`Error processing service ${serviceId}:`, error);
        }
    }

    const { duration, formatted_duration } = calculateCartDuration(fullServices);

    return {
        ...shortCart,
        items: fullServices,
        book_datetime: bookDateTimeStr,
        duration,
        formatted_duration,
    };
}

function configureVariantOptions(
    variant: ServiceVariant,
    selectedOptions: { [optionId: string]: string }
): ServiceVariant {
    const configuredVariant: ServiceVariant = {
        id: variant.id,
        name: variant.name,
        price: variant.price,
        durationValue: (variant as any).durationValue,
        durationUnit: (variant as any).durationUnit,
        options: [],
    };

    for (const option of variant.options || []) {
        const selectedChoiceId = selectedOptions[option.id];

        let selectedChoice: Choice | null = null;
        if (selectedChoiceId && option.choices) {
            const choice = option.choices.find(c => c.id === selectedChoiceId);
            if (choice) {
                selectedChoice = { ...choice };
            }
        }

        const configuredOption: Option = {
            id: option.id,
            name: option.name,
            choices: option.choices ? option.choices.map(c => ({ ...c })) : [],
            selected_choice: selectedChoice,
            selected_choice_id: selectedChoiceId || null,
        };

        configuredVariant.options.push(configuredOption);
    }

    return configuredVariant;
}

export default {
    getBookingDetail,
    getBookingDetailById,
    getBookingsByMode,
};