// listing/book.ts

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
    vendor_id?: string;
    created_at?: string;
    status?: string;
    items: CartItemShort[];
    total_amount?: number;
    book_datetime?: string;
    duration?: number;
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
    duration_value?: number;
    duration_unit?: string;
    options: Option[];
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
}

interface CartModel {
    id?: string;
    client_id?: string;
    vendor_id?: string;
    created_at?: string;
    status?: string;
    items: ServiceModel[];
    client?: UserData;
    vendor?: UserData;
}

interface BookingListResponse {
    success: boolean;
    data: {
        bookings: CartModel[];
        count: number;
        mode: string;
        id: string;
        expanded: boolean;
        hasMore: boolean;
        nextCursor?: string;
        totalCount?: number;
    };
    error?: string;
    message?: string;
}

// ============================================================
// ENDPOINTS
// ============================================================

/**
 * POST /api/v1/listing/booking-detail
 *
 * Expand a short cart/booking model to full detailed version
 *
 * Request body:
 * { bookingId: "xxx" } OR { cartData: {...} }
 */
export async function getBookingDetail(req: Request, res: Response) {
    try {
        const { bookingId, cartData } = req.body;
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

        const fullCart = await expandShortCart(shortCart);

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
 * GET /api/v1/listing/booking-detail-by-id?bookingId=xxx
 *
 * Fetch and expand booking by ID
 */
export async function getBookingDetailById(req: Request, res: Response) {
    try {
        const bookingId = req.query.bookingId as string;

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

        const fullCart = await expandShortCart(shortCart);

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
 * GET/POST /api/v1/listing/bookings-by-mode
 *
 * Fetch bookings by client_id or vendor_id with pagination & infinite loading
 *
 * Query params or body:
 * - mode: "client" | "vendor" (REQUIRED)
 * - id: the client_id or vendor_id (REQUIRED)
 * - expand: "true" | "false" (optional, default false)
 * - status: "PENDING" | "APPROVED" | "CANCELED" | "REJECTED" (optional)
 * - limit: number 1-100 (optional, default 10)
 * - cursor: string for pagination (optional)
 * - sortBy: "created_at" | "book_datetime" | "status" (optional, default "created_at")
 * - sortOrder: "asc" | "desc" (optional, default "desc")
 */
export async function getBookingsByMode(req: Request, res: Response): Promise<any> {
    try {
        // ✅ Accept both query params (GET) and body (POST)
        const mode = (req.query.mode || req.body.mode) as string;
        const id = (req.query.id || req.body.id) as string;
        const expand = (req.query.expand || req.body.expand) === 'true';
        const status = (req.query.status || req.body.status) as string | undefined;
        const cursor = (req.query.cursor || req.body.cursor) as string | undefined;
        const limit = Math.min(parseInt((req.query.limit || req.body.limit || '10') as string), 100);
        const sortBy = (req.query.sortBy || req.body.sortBy || 'created_at') as string;
        const sortOrder = (req.query.sortOrder || req.body.sortOrder || 'desc') as 'asc' | 'desc';

        // ✅ Validate mode
        if (!mode || (mode !== 'client' && mode !== 'vendor')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid mode. Must be "client" or "vendor"'
            });
        }

        // ✅ Validate id
        if (!id) {
            return res.status(400).json({
                success: false,
                error: `Missing ${mode}_id parameter`
            });
        }

        // ✅ Validate limit
        if (limit < 1 || limit > 100) {
            return res.status(400).json({
                success: false,
                error: 'Limit must be between 1 and 100'
            });
        }

        // ✅ Validate sortBy
        const validSortFields = ['created_at', 'book_datetime', 'status'];
        const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'created_at';

        console.log(`\n🔍 Fetching bookings:`);
        console.log(`   Mode: ${mode}`);
        console.log(`   ID: ${id}`);
        console.log(`   Status: ${status || 'all'}`);
        console.log(`   Sort: ${finalSortBy} ${sortOrder}`);
        console.log(`   Limit: ${limit}`);
        console.log(`   Cursor: ${cursor || 'none'}`);
        console.log(`   Expand: ${expand}`);

        const fieldName = mode === 'client' ? 'client_id' : 'vendor_id';

        // ✅ Build query
        let query = db
            .collection(BOOKING_COLLECTION)
            .where(fieldName, '==', id);

        // ✅ Add status filter if provided
        if (status) {
            query = query.where('status', '==', status);
        }

        // ✅ Add sorting
        query = query.orderBy(finalSortBy, sortOrder);

        // ✅ Handle cursor-based pagination
        if (cursor) {
            try {
                console.log(`   Using cursor: ${cursor}`);

                const cursorDoc = await db
                    .collection(BOOKING_COLLECTION)
                    .doc(cursor)
                    .get();

                if (cursorDoc.exists) {
                    const cursorValue = cursorDoc.get(finalSortBy);
                    console.log(`   Cursor value: ${cursorValue}`);
                    query = query.startAfter(cursorValue);
                } else {
                    console.warn(`   ⚠️ Cursor document not found`);
                }
            } catch (error) {
                console.warn('   ⚠️ Invalid cursor, starting from beginning:', error);
            }
        }

        // ✅ Fetch limit + 1 to determine if there are more results
        const snapshot = await query.limit(limit + 1).get();

        console.log(`   📊 Documents fetched: ${snapshot.docs.length}`);

        if (snapshot.empty) {
            console.log(`   ℹ️ No bookings found`);

            return res.status(200).json({
                success: true,
                data: {
                    bookings: [],
                    count: 0,
                    mode,
                    id,
                    expanded: false,
                    hasMore: false,
                    nextCursor: undefined,
                    totalCount: 0
                }
            } as BookingListResponse);
        }

        // ✅ Check if there are more results
        const docs = snapshot.docs;
        const hasMore = docs.length > limit;
        const bookingDocs = hasMore ? docs.slice(0, limit) : docs;

        console.log(`   ✅ Has more: ${hasMore}`);

        // ✅ Convert to short carts
        const shortCarts: CartModelShort[] = bookingDocs.map(doc => {
            const data = doc.data() as CartModelShort;
            data.id = doc.id;
            return data;
        });

        // ✅ Determine next cursor for infinite loading
        const nextCursor = hasMore && bookingDocs.length > 0
            ? bookingDocs[bookingDocs.length - 1].id
            : undefined;

        // ✅ If expand is true, expand all bookings with full service data
        if (expand) {
            console.log(`   📦 Expanding ${shortCarts.length} bookings...`);

            const expandedCarts: CartModel[] = [];

            for (const shortCart of shortCarts) {
                try {
                    const fullCart = await expandShortCart(shortCart);
                    expandedCarts.push(fullCart);
                } catch (error) {
                    console.error(`   ❌ Error expanding booking ${shortCart.id}:`, error);
                }
            }

            console.log(`   ✅ Expansion complete\n`);

            return res.status(200).json({
                success: true,
                data: {
                    bookings: expandedCarts,
                    count: expandedCarts.length,
                    mode,
                    id,
                    expanded: true,
                    hasMore,
                    nextCursor,
                    totalCount: expandedCarts.length
                }
            } as BookingListResponse);
        }

        // ✅ For non-expanded, enrich with user data from users collection
        console.log(`   👤 Enriching ${shortCarts.length} bookings with user data...`);

        const enrichedBookings = await Promise.all(
            shortCarts.map(booking => enrichBookingWithUserData(booking))
        );

        console.log(`   ✅ Enrichment complete\n`);

        return res.status(200).json({
            success: true,
            data: {
                bookings: enrichedBookings,
                count: enrichedBookings.length,
                mode,
                id,
                expanded: false,
                hasMore,
                nextCursor,
                totalCount: enrichedBookings.length
            }
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

/**
 * Fetch user data from the users collection
 */
async function fetchUserData(userId: string): Promise<UserData | null> {
    try {
        if (!userId) return null;

        console.log(`      👤 Fetching user: ${userId}`);

        const userDoc = await db
            .collection(USERS_COLLECTION)
            .doc(userId)
            .get();

        if (!userDoc.exists) {
            console.warn(`      ⚠️ User not found: ${userId}`);
            return null;
        }

        const userData = userDoc.data() as UserData;
        userData.uid = userDoc.id;

        console.log(`      ✅ User found: ${userData.name}`);

        return userData;

    } catch (error) {
        console.error(`      ❌ Error fetching user ${userId}:`, error);
        return null;
    }
}

/**
 * ✅ NEW: Enrich a booking with user and vendor data (short version, no service expansion)
 * Used for non-expanded bookings in infinite loading
 */
async function enrichBookingWithUserData(
    booking: CartModelShort
): Promise<CartModel> {
    console.log(`      Enriching booking: ${booking.id}`);

    const [clientData, vendorData] = await Promise.all([
        booking.client_id ? fetchUserData(booking.client_id) : Promise.resolve(null),
        booking.vendor_id ? fetchUserData(booking.vendor_id) : Promise.resolve(null),
    ]);

    return {
        id: booking.id,
        client_id: booking.client_id,
        vendor_id: booking.vendor_id,
        created_at: booking.created_at,
        status: booking.status,
        items: [], // Empty for non-expanded
        client: clientData || undefined,
        vendor: vendorData || undefined,
    };
}

/**
 * Expand a CartModelShort to full CartModel by fetching service details
 * Also fetches client and vendor user data from users collection
 */
async function expandShortCart(shortCart: CartModelShort): Promise<CartModel> {
    console.log(`\n🔄 EXPANDING CART: ${shortCart.id}`);
    console.log(`   Items to expand: ${shortCart.items.length}`);

    const fullServices: ServiceModel[] = [];

    // ✅ Fetch client and vendor data from users collection
    console.log(`   👤 Fetching user data...`);
    const [clientData, vendorData] = await Promise.all([
        shortCart.client_id ? fetchUserData(shortCart.client_id) : Promise.resolve(null),
        shortCart.vendor_id ? fetchUserData(shortCart.vendor_id) : Promise.resolve(null),
    ]);

    // Validate items
    if (!shortCart.items || shortCart.items.length === 0) {
        console.warn('   ⚠️ No items in cart');

        return {
            id: shortCart.id,
            client_id: shortCart.client_id,
            vendor_id: shortCart.vendor_id,
            created_at: shortCart.created_at,
            status: shortCart.status,
            items: [],
            client: clientData || undefined,
            vendor: vendorData || undefined,
        };
    }

    // Group items by service_id
    const serviceGroups = new Map<string, CartItemShort[]>();

    for (const item of shortCart.items) {
        if (!item.service_id) {
            console.warn('   ⚠️ Cart item has no service_id:', item);
            continue;
        }

        if (!serviceGroups.has(item.service_id)) {
            serviceGroups.set(item.service_id, []);
        }
        serviceGroups.get(item.service_id)!.push(item);
    }

    console.log(`   📦 Found ${serviceGroups.size} unique services`);

    // Fetch and expand each service
    for (const [serviceId, cartItems] of serviceGroups.entries()) {
        try {
            console.log(`\n   🔍 Fetching service: ${serviceId}`);

            const serviceDoc = await db
                .collection(SERVICES_COLLECTION)
                .doc(serviceId)
                .get();

            if (!serviceDoc.exists) {
                console.error(`   ❌ Service not found: ${serviceId}`);
                continue;
            }

            const serviceData = serviceDoc.data() as ServiceModel;
            serviceData.id = serviceDoc.id;

            console.log(`   ✅ Service found: ${serviceData.name}`);
            console.log(`      Variants: ${serviceData.variants.length} | Cart items: ${cartItems.length}`);

            // Process each cart item for this service
            const selectedVariants: ServiceVariant[] = [];

            for (const cartItem of cartItems) {
                console.log(`      📌 Variant: ${cartItem.variant_id}`);

                if (!cartItem.variant_id) {
                    console.warn(`      ⚠️ No variant_id`);
                    continue;
                }

                const variant = serviceData.variants.find(v => v.id === cartItem.variant_id);

                if (!variant) {
                    console.error(`      ❌ Variant not found`);
                    continue;
                }

                console.log(`      ✅ ${variant.name}`);

                const configuredVariant = configureVariantOptions(
                    variant,
                    cartItem.selected_options || {}
                );

                selectedVariants.push(configuredVariant);
            }

            console.log(`   📊 Selected variants: ${selectedVariants.length}`);

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
                console.log(`   ✅ Service added`);
            } else {
                console.warn(`   ⚠️ No variants selected`);
            }

        } catch (error) {
            console.error(`   ❌ Error processing service ${serviceId}:`, error);
        }
    }

    console.log(`\n✅ EXPANSION COMPLETE: ${fullServices.length} services\n`);

    return {
        id: shortCart.id,
        client_id: shortCart.client_id,
        vendor_id: shortCart.vendor_id,
        created_at: shortCart.created_at,
        status: shortCart.status,
        items: fullServices,
        client: clientData || undefined,
        vendor: vendorData || undefined,
    };
}

/**
 * Configure variant options with selected choices
 */
function configureVariantOptions(
    variant: ServiceVariant,
    selectedOptions: { [optionId: string]: string }
): ServiceVariant {
    const configuredVariant: ServiceVariant = {
        id: variant.id,
        name: variant.name,
        price: variant.price,
        duration_value: variant.duration_value,
        duration_unit: variant.duration_unit,
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