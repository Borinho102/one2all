// listing/book.ts

import { Request, Response } from "express";
import admin from "firebase-admin";

const db = admin.firestore();
const BOOKING_COLLECTION = 'booking';
const SERVICES_COLLECTION = 'services';
const USERS_COLLECTION = 'users';

// ============= INTERFACES =============

interface UserData {
    uid?: string;
    name?: string;
    email?: string;
    phone?: string;
    avatar?: string;
    role?: string;
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
    // ✅ New: User and vendor data
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
        // ✅ New: Pagination info
        hasMore: boolean;
        nextCursor?: string;
        totalCount?: number;
    };
    error?: string;
    message?: string;
}

// ============= MAIN ENDPOINTS =============

/**
 * POST /api/v1/listing/booking-detail
 *
 * Expand a short cart/booking model to full detailed version
 * Now includes client and vendor user data
 *
 * Request body:
 * { bookingId: "xxx" } OR { cartData: {...} }
 */
export async function getBookingDetail(req: Request, res: Response) {
    try {
        const { bookingId, cartData } = req.body;
        let shortCart: CartModelShort;

        // Option 1: Fetch by booking ID
        if (bookingId) {
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
        }
        // Option 2: Use provided cart data
        else if (cartData) {
            shortCart = cartData as CartModelShort;
        }
        // Invalid request
        else {
            return res.status(400).json({
                success: false,
                error: 'Invalid request. Provide either "bookingId" or "cartData"'
            });
        }

        // Validate cart has items
        if (!shortCart.items || shortCart.items.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Cart has no items'
            });
        }

        // Expand cart to full detail with user data
        const fullCart = await expandShortCart(shortCart);

        // Return success response
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
 * Simplified GET endpoint to fetch and expand booking by ID
 * Now includes client and vendor user data
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

        // Fetch booking from Firestore
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

        // Expand to full detail with user data
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
 * Fetch bookings by client_id or vendor_id with pagination
 *
 * Query params or body:
 * - mode: "client" | "vendor"
 * - id: the client_id or vendor_id
 * - expand: "true" | "false" (optional, default false)
 * - status: "PENDING" | "APPROVED" | "CANCELED" | "REJECTED" (optional)
 * - limit: number (optional, default 10, max 100)
 * - cursor: string (optional, for pagination - use nextCursor from previous response)
 * - sortBy: "created_at" | "book_datetime" | "status" (optional, default "created_at")
 * - sortOrder: "asc" | "desc" (optional, default "desc")
 */
export async function getBookingsByMode(req: Request, res: Response): Promise<any> {
    try {
        // Accept both query params (GET) and body (POST)
        const mode = (req.query.mode || req.body.mode) as string;
        const id = (req.query.id || req.body.id) as string;
        const expand = (req.query.expand || req.body.expand) === 'true';
        const status = (req.query.status || req.body.status) as string | undefined;
        const cursor = (req.query.cursor || req.body.cursor) as string | undefined;
        const limit = Math.min(parseInt((req.query.limit || req.body.limit || '10') as string), 100);
        const sortBy = (req.query.sortBy || req.body.sortBy || 'created_at') as string;
        const sortOrder = (req.query.sortOrder || req.body.sortOrder || 'desc') as 'asc' | 'desc';

        // Validate mode
        if (!mode || (mode !== 'client' && mode !== 'vendor')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid mode. Must be "client" or "vendor"'
            });
        }

        // Validate id
        if (!id) {
            return res.status(400).json({
                success: false,
                error: `Missing ${mode}_id parameter`
            });
        }

        // Validate limit
        if (limit < 1 || limit > 100) {
            return res.status(400).json({
                success: false,
                error: 'Limit must be between 1 and 100'
            });
        }

        // Validate sortBy
        const validSortFields = ['created_at', 'book_datetime', 'status'];
        const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'created_at';

        // Determine which field to query
        const fieldName = mode === 'client' ? 'client_id' : 'vendor_id';

        // Build initial query
        let query = db
            .collection(BOOKING_COLLECTION)
            .where(fieldName, '==', id);

        // Add status filter if provided
        if (status) {
            query = query.where('status', '==', status);
        }

        // Add sorting
        query = query.orderBy(finalSortBy, sortOrder);

        // Handle cursor-based pagination
        if (cursor) {
            try {
                const cursorDoc = await db
                    .collection(BOOKING_COLLECTION)
                    .doc(cursor)
                    .get();

                if (cursorDoc.exists) {
                    const cursorValue = cursorDoc.get(finalSortBy);
                    if (sortOrder === 'desc') {
                        query = query.startAfter(cursorValue);
                    } else {
                        query = query.startAfter(cursorValue);
                    }
                }
            } catch (error) {
                console.warn('Invalid cursor, starting from beginning:', error);
            }
        }

        // Fetch limit + 1 to determine if there are more results
        const snapshot = await query.limit(limit + 1).get();

        if (snapshot.empty) {
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

        // Convert to array and check if there are more
        const docs = snapshot.docs;
        const hasMore = docs.length > limit;
        const bookingDocs = hasMore ? docs.slice(0, limit) : docs;

        // Convert to short carts
        const shortCarts: CartModelShort[] = bookingDocs.map(doc => {
            const data = doc.data() as CartModelShort;
            data.id = doc.id;
            return data;
        });

        // Determine next cursor
        const nextCursor = hasMore && bookingDocs.length > 0
            ? bookingDocs[bookingDocs.length - 1].id
            : undefined;

        // If expand is true, expand all bookings with user data
        if (expand) {
            const expandedCarts: CartModel[] = [];

            for (const shortCart of shortCarts) {
                try {
                    const fullCart = await expandShortCart(shortCart);
                    expandedCarts.push(fullCart);
                } catch (error) {
                    console.error(`Error expanding booking ${shortCart.id}:`, error);
                    // Continue with other bookings
                }
            }

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

        // Return short format with user data
        const enrichedBookings = await Promise.all(
            shortCarts.map(booking => enrichBookingWithUserData(booking))
        );

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

// ============= HELPER FUNCTIONS =============

/**
 * Enrich a booking with user and vendor data (short version)
 */
async function enrichBookingWithUserData(
    booking: CartModelShort
): Promise<CartModel> {
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
        items: [],
        client: clientData || undefined,
        vendor: vendorData || undefined,
    };
}



/**
 * Expand a CartModelShort to full CartModel by fetching service details
 * Now includes user and vendor data with FULL items array
 */
async function expandShortCart(shortCart: CartModelShort): Promise<CartModel> {
    const fullServices: ServiceModel[] = [];

    // Fetch user and vendor data in parallel
    const [clientData, vendorData] = await Promise.all([
        shortCart.client_id ? fetchUserData(shortCart.client_id) : Promise.resolve(null),
        shortCart.vendor_id ? fetchUserData(shortCart.vendor_id) : Promise.resolve(null),
    ]);

    // Validate items exist
    if (!shortCart.items || shortCart.items.length === 0) {
        console.warn('⚠️ Cart has no items');

        const emptyCart: CartModel = {
            id: shortCart.id,
            client_id: shortCart.client_id,
            vendor_id: shortCart.vendor_id,
            created_at: shortCart.created_at,
            status: shortCart.status,
            items: [],
            client: clientData || undefined,
            vendor: vendorData || undefined,
        };
        return emptyCart;
    }

    // Group cart items by serviceId to minimize database queries
    const serviceGroups = new Map<string, CartItemShort[]>();

    for (const item of shortCart.items) {
        if (!serviceGroups.has(item.service_id)) {
            serviceGroups.set(item.service_id, []);
        }
        serviceGroups.get(item.service_id)!.push(item);
    }

    console.log(`📦 Expanding ${serviceGroups.size} services with ${shortCart.items.length} items`);

    // Fetch each service and reconstruct with selected variants
    for (const [serviceId, cartItems] of serviceGroups.entries()) {
        try {
            console.log(`🔍 Fetching service: ${serviceId}`);

            // Fetch service from Firestore
            const serviceDoc = await db
                .collection(SERVICES_COLLECTION)
                .doc(serviceId)
                .get();

            if (!serviceDoc.exists) {
                console.warn(`⚠️ Service not found: ${serviceId}, skipping...`);
                continue;
            }

            const serviceData = serviceDoc.data() as ServiceModel;
            serviceData.id = serviceDoc.id;

            console.log(`✅ Service found: ${serviceData.name}, variants: ${serviceData.variants.length}`);

            // Filter and configure variants based on cart items
            const selectedVariants: ServiceVariant[] = [];

            for (const cartItem of cartItems) {
                console.log(`  └─ Processing variant: ${cartItem.variant_id}`);

                // Find the variant in the full service
                const variant = serviceData.variants.find(
                    v => v.id === cartItem.variant_id
                );

                if (!variant) {
                    console.warn(
                        `⚠️ Variant ${cartItem.variant_id} not found in service ${serviceId}, skipping...`
                    );
                    continue;
                }

                // Create a copy of the variant with selected options configured
                const configuredVariant = configureVariantOptions(
                    variant,
                    cartItem.selected_options || {}
                );

                selectedVariants.push(configuredVariant);
                console.log(`  ✅ Variant added: ${configuredVariant.name}`);
            }

            // Create service with only selected variants
            if (selectedVariants.length > 0) {
                const serviceWithSelectedVariants: ServiceModel = {
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

                fullServices.push(serviceWithSelectedVariants);
                console.log(`✅ Service with variants added to cart`);
            } else {
                console.warn(`⚠️ No variants found for service ${serviceId}`);
            }

        } catch (error) {
            console.error(`❌ Error fetching service ${serviceId}:`, error);
            // Continue with other services
        }
    }

    console.log(`✅ Expanded to ${fullServices.length} services total`);

    // Create full cart model with user data
    const fullCart: CartModel = {
        id: shortCart.id,
        client_id: shortCart.client_id,
        vendor_id: shortCart.vendor_id,
        created_at: shortCart.created_at,
        status: shortCart.status,
        items: fullServices,
        client: clientData || undefined,
        vendor: vendorData || undefined,
    };

    return fullCart;
}

/**
 * Fetch user data from the users collection
 */
async function fetchUserData(userId: string): Promise<UserData | null> {
    try {
        if (!userId) return null;

        const userDoc = await db
            .collection(USERS_COLLECTION)
            .doc(userId)
            .get();

        if (!userDoc.exists) {
            console.warn(`⚠️ User not found: ${userId}`);
            return null;
        }

        const userData = userDoc.data() as UserData;
        userData.uid = userDoc.id;

        console.log(`✅ User fetched: ${userData.name}`);

        return userData;

    } catch (error) {
        console.error(`❌ Error fetching user ${userId}:`, error);
        return null;
    }
}

/**
 * Configure a variant's options by setting the selected choices
 * based on the selected_options map from the cart item
 */
function configureVariantOptions(
    variant: ServiceVariant,
    selectedOptions: { [optionId: string]: string }
): ServiceVariant {
    // Deep clone the variant to avoid modifying the original
    const configuredVariant: ServiceVariant = {
        id: variant.id,
        name: variant.name,
        price: variant.price,
        duration_value: variant.duration_value,
        duration_unit: variant.duration_unit,
        options: [],
    };

    // Configure each option with selected choice
    for (const option of variant.options) {
        const selectedChoiceId = selectedOptions[option.id];

        // Find the selected choice
        let selectedChoice: Choice | null = null;
        if (selectedChoiceId) {
            const choice = option.choices.find(c => c.id === selectedChoiceId);
            if (choice) {
                selectedChoice = { ...choice };
            }
        }

        // Create configured option
        const configuredOption: Option = {
            id: option.id,
            name: option.name,
            choices: option.choices.map(c => ({ ...c })), // Deep copy choices
            selected_choice: selectedChoice,
            selected_choice_id: selectedChoiceId || null,
        };

        configuredVariant.options.push(configuredOption);
    }

    return configuredVariant;
}