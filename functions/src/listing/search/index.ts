import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

/**
 * ENHANCED SEARCH DATA FUNCTION WITH MULTI-LEVEL ARRAY FILTERING
 *
 * Features:
 * - Multi-level nested field filtering (e.g., "address.city.name")
 * - Array property filtering (e.g., "serviceCategories.key")
 * - Complex AND/OR filter logic
 * - Full-text search with relevance scoring
 * - Sorting and pagination
 * - Population (forward and reverse)
 *
 * EXAMPLES:
 *
 * 1. Filter by nested array property:
 *    {
 *      "filters": {
 *        "logic": "and",
 *        "filters": [
 *          {"field": "role", "operator": "eq", "value": "vendor"},
 *          {"field": "serviceCategories.key", "operator": "eq", "value": "hair"}
 *        ]
 *      }
 *    }
 *
 * 2. OR logic on array properties:
 *    {
 *      "filters": {
 *        "logic": "or",
 *        "filters": [
 *          {"field": "tags", "operator": "contains", "value": "premium"},
 *          {"field": "categories.name", "operator": "eq", "value": "luxury"}
 *        ]
 *      }
 *    }
 *
 * 3. Deep nested filtering:
 *    {
 *      "filters": {
 *        "logic": "and",
 *        "filters": [
 *          {"field": "orders.items.price", "operator": "gt", "value": 100},
 *          {"field": "orders.status", "operator": "eq", "value": "completed"}
 *        ]
 *      }
 *    }
 */

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();
const COLLECTION = 'services';

// ============================================================
// TYPE DEFINITIONS
// ============================================================

interface FilterCriteria {
    field: string;
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'startsWith' | 'endsWith' | 'between';
    value: any;
    value2?: any;
}

interface FilterGroup {
    logic?: 'and' | 'or';
    filters: (FilterCriteria | FilterGroup)[];
}

interface SortCriteria {
    field: string;
    order: 'asc' | 'desc';
}

interface PopulateOptions {
    field?: string;
    link?: string;
    collection: string;
    select?: string | string[];
    as?: string;
    type?: 'forward' | 'reverse';
    populate?: PopulateOptions[];
}

interface SpecialFilter {
    type: string;
    [key: string]: any;
}

interface SpecialSort {
    type: string;
    [key: string]: any;
}

// ============================================================
// SPECIAL FILTERS FOR SPECIFIC COLLECTIONS
// ============================================================

/**
 * Parse date from MM-DD-YYYY format
 */
function parseDate(dateString: string): Date | null {
    try {
        const parts = dateString.split('-');
        if (parts.length !== 3) return null;

        const month = parseInt(parts[0], 10) - 1; // Month is 0-indexed
        const day = parseInt(parts[1], 10);
        const year = parseInt(parts[2], 10);

        if (isNaN(month) || isNaN(day) || isNaN(year)) return null;

        const date = new Date(year, month, day);

        // Validate the date
        if (date.getMonth() !== month || date.getDate() !== day || date.getFullYear() !== year) {
            return null;
        }

        return date;
    } catch {
        return null;
    }
}

/**
 * Get day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 */
function getDayOfWeek(date: Date): number {
    return date.getDay();
}

/**
 * Map day of week number to French day name
 */
function getDayNameInFrench(dayOfWeek: number): string {
    const dayNames = [
        'Dimanche',  // 0 = Sunday
        'Lundi',     // 1 = Monday
        'Mardi',     // 2 = Tuesday
        'Mercredi',  // 3 = Wednesday
        'Jeudi',     // 4 = Thursday
        'Vendredi',  // 5 = Friday
        'Samedi'     // 6 = Saturday
    ];
    return dayNames[dayOfWeek];
}

/**
 * Check if a user's working day is open for a specific date
 *
 * @param doc - The user document
 * @param dateString - Date in MM-DD-YYYY format
 * @returns true if the working day is open, false otherwise
 */
function checkWorkingDayOpen(doc: any, dateString: string): boolean {
    const date = parseDate(dateString);
    if (!date) {
        console.error('Invalid date format. Expected MM-DD-YYYY');
        return false;
    }

    const dayOfWeek = getDayOfWeek(date);
    const dayName = getDayNameInFrench(dayOfWeek);

    // Check if workingDays array exists
    if (!doc.workingDays || !Array.isArray(doc.workingDays)) {
        return false;
    }

    // Find the working day entry by matching the name field
    const workingDay = doc.workingDays.find((wd: any) => {
        return wd.name === dayName;
    });

    if (!workingDay) {
        return false;
    }

    // Check if isOpen is true
    return workingDay.isOpen === true;
}

/**
 * Apply special filters based on collection type
 */
function applySpecialFilters(
    documents: any[],
    specialFilter: SpecialFilter,
    collectionName: string
): any[] {
    if (!specialFilter || !specialFilter.type) {
        return documents;
    }

    // Collection-specific special filters
    if (collectionName === 'users') {
        switch (specialFilter.type) {
            case 'workingDayOpen':
                const date = specialFilter.date;
                if (!date) {
                    console.error('Special filter "workingDayOpen" requires a "date" parameter in MM-DD-YYYY format');
                    return documents;
                }

                return documents.filter(doc => checkWorkingDayOpen(doc, date));

            default:
                console.warn(`Unknown special filter type for users collection: ${specialFilter.type}`);
                return documents;
        }
    }

    // Add more collection-specific filters here
    console.warn(`Special filters not implemented for collection: ${collectionName}`);
    return documents;
}

/**
 * Parse special filter from request parameters
 */
function parseSpecialFilter(specialFilterParam: any): SpecialFilter | null {
    if (!specialFilterParam) return null;

    if (typeof specialFilterParam === 'string') {
        try {
            return JSON.parse(specialFilterParam);
        } catch {
            return null;
        }
    }

    if (typeof specialFilterParam === 'object' && specialFilterParam.type) {
        return specialFilterParam;
    }

    return null;
}

/**
 * Parse special sort from request parameters
 */
function parseSpecialSort(specialSortParam: any): SpecialSort | null {
    if (!specialSortParam) return null;

    if (typeof specialSortParam === 'string') {
        try {
            return JSON.parse(specialSortParam);
        } catch {
            return null;
        }
    }

    if (typeof specialSortParam === 'object' && specialSortParam.type) {
        return specialSortParam;
    }

    return null;
}

// ============================================================
// SPECIAL SORT FUNCTIONS
// ============================================================

/**
 * Calculate distance between two coordinates using Haversine formula
 * Returns distance in kilometers
 *
 * @param lat1 - Latitude of first point
 * @param lon1 - Longitude of first point
 * @param lat2 - Latitude of second point
 * @param lon2 - Longitude of second point
 * @returns Distance in kilometers
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Radius of the Earth in kilometers

    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const distance = R * c; // Distance in kilometers

    return distance;
}

/**
 * Convert degrees to radians
 */
function toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
}

/**
 * Sort documents by distance from a given location
 *
 * @param documents - Array of documents to sort
 * @param userLat - User's latitude
 * @param userLon - User's longitude
 * @param latField - Field path for latitude in documents (default: "address.latitude")
 * @param lonField - Field path for longitude in documents (default: "address.longitude")
 * @param order - Sort order: 'asc' for nearest first, 'desc' for farthest first
 * @returns Sorted documents with distance field added
 */
function sortByDistance(
    documents: any[],
    userLat: number,
    userLon: number,
    latField: string = 'address.latitude',
    lonField: string = 'address.longitude',
    order: 'asc' | 'desc' = 'asc'
): any[] {
    console.log(`Sorting by distance from (${userLat}, ${userLon})`);
    console.log(`Using fields: ${latField}, ${lonField}`);

    // Calculate distance for each document and add it as a field
    const documentsWithDistance = documents.map(doc => {
        const docLat = getNestedValue(doc, latField);
        const docLon = getNestedValue(doc, lonField);

        console.log(`Document ${doc.id}: lat=${docLat}, lon=${docLon}`);

        // Check if coordinates are valid
        if (
            docLat === null || docLat === undefined ||
            docLon === null || docLon === undefined ||
            isNaN(Number(docLat)) || isNaN(Number(docLon))
        ) {
            console.log(`Document ${doc.id}: Invalid coordinates, setting distance to null (will be pushed to end)`);
            return {
                ...doc,
                distance: null, // Use null instead of Infinity for JSON serialization
                distanceRaw: Infinity // Keep Infinity for sorting
            };
        }

        const distance = calculateDistance(
            userLat,
            userLon,
            Number(docLat),
            Number(docLon)
        );

        console.log(`Document ${doc.id}: distance = ${distance} km`);

        return {
            ...doc,
            distance: distance,
            distanceRaw: distance
        };
    });

    // Sort by distance using distanceRaw
    const sorted = documentsWithDistance.sort((a, b) => {
        if (order === 'asc') {
            return a.distanceRaw - b.distanceRaw;
        } else {
            return b.distanceRaw - a.distanceRaw;
        }
    });

    // Keep distanceRaw for combined sorting (will be removed later if needed)
    console.log(`Sorted ${sorted.length} documents by distance`);

    return sorted;
}

/**
 * Apply special sort based on type
 * Special sorts take priority over regular sort criteria
 */
function applySpecialSort(
    documents: any[],
    specialSort: SpecialSort,
    collectionName: string
): any[] {
    if (!specialSort || !specialSort.type) {
        return documents;
    }

    console.log('Applying special sort:', JSON.stringify(specialSort));

    // Collection-specific special sorts
    if (collectionName === 'users') {
        switch (specialSort.type) {
            case 'distance':
                const { lat, lon, latitude, longitude, order } = specialSort;

                // Accept either lat/lon or latitude/longitude
                const userLat = lat !== undefined ? lat : latitude;
                const userLon = lon !== undefined ? lon : longitude;

                console.log(`Distance sort - User position: lat=${userLat}, lon=${userLon}`);

                if (userLat === undefined || userLon === undefined) {
                    console.error('Special sort "distance" requires "lat" and "lon" (or "latitude" and "longitude") parameters');
                    return documents;
                }

                if (isNaN(Number(userLat)) || isNaN(Number(userLon))) {
                    console.error('Special sort "distance" requires valid numeric coordinates');
                    return documents;
                }

                // Optional: custom field paths for latitude and longitude
                const latField = specialSort.latField || 'address.latitude';
                const lonField = specialSort.lonField || 'address.longitude';
                const sortOrder = (order as 'asc' | 'desc') || 'asc';

                console.log(`Using coordinate fields: ${latField}, ${lonField}`);
                console.log(`Sort order: ${sortOrder}`);

                return sortByDistance(
                    documents,
                    Number(userLat),
                    Number(userLon),
                    latField,
                    lonField,
                    sortOrder
                );

            default:
                console.warn(`Unknown special sort type for users collection: ${specialSort.type}`);
                return documents;
        }
    }

    // Add more collection-specific sorts here
    console.warn(`Special sorts not implemented for collection: ${collectionName}`);
    return documents;
}

/**
 * Apply combined sorting: special sort (primary) + regular sort (tie-breaker)
 */
function applyCombinedSort(
    documents: any[],
    specialSort: SpecialSort | null,
    sortCriteria: SortCriteria[],
    collectionName: string
): any[] {
    // If no special sort, just apply regular sort
    if (!specialSort) {
        return sortDocuments(documents, sortCriteria);
    }

    // Apply special sort first
    let sortedDocs = applySpecialSort(documents, specialSort, collectionName);

    // If no regular sort criteria, return special-sorted results
    if (!sortCriteria || sortCriteria.length === 0) {
        return sortedDocs;
    }

    // Get the sort order from special sort
    const specialSortOrder = specialSort.order || 'asc';

    // Apply regular sort as tie-breaker
    // For distance sorting, this means: sort by distance first, then by other criteria when distances are equal
    return sortedDocs.sort((a, b) => {
        // First compare by distance (if it exists from special sort)
        if (specialSort.type === 'distance') {
            const distA = a.distanceRaw !== undefined ? a.distanceRaw : (a.distance !== null ? a.distance : Infinity);
            const distB = b.distanceRaw !== undefined ? b.distanceRaw : (b.distance !== null ? b.distance : Infinity);

            // Apply the sort order from special sort
            const distanceComparison = specialSortOrder === 'desc'
                ? distB - distA  // descending: farthest first
                : distA - distB; // ascending: nearest first

            // If distances are different, use distance for sorting
            if (Math.abs(distanceComparison) > 0.0001) { // Use small epsilon for floating point comparison
                return distanceComparison;
            }

            // Distances are equal, use regular sort criteria as tie-breaker
        }

        // Apply regular sort criteria
        for (const criteria of sortCriteria) {
            const valueA = getNestedValue(a, criteria.field);
            const valueB = getNestedValue(b, criteria.field);

            const comparison = compareSortValues(valueA, valueB, criteria.order);

            if (comparison !== 0) {
                return comparison;
            }
        }

        return 0;
    });
}

function isFirestoreTimestamp(value: any): boolean {
    return (
        value !== null &&
        typeof value === 'object' &&
        ('_seconds' in value || 'seconds' in value) &&
        ('_nanoseconds' in value || 'nanoseconds' in value)
    );
}

function firestoreTimestampToDate(timestamp: any): Date | null {
    if (!isFirestoreTimestamp(timestamp)) return null;
    const seconds = timestamp._seconds || timestamp.seconds;
    const nanoseconds = timestamp._nanoseconds || timestamp.nanoseconds || 0;
    return new Date(seconds * 1000 + nanoseconds / 1000000);
}

/**
 * Enhanced function to get nested field value with array traversal support
 * Automatically extracts nested properties from arrays
 */
function getNestedValue(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];

        if (current === null || current === undefined) {
            return undefined;
        }

        // Handle array notation (e.g., "items[0].name")
        const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);

        if (arrayMatch) {
            const [, arrayName, index] = arrayMatch;
            current = current[arrayName];
            if (Array.isArray(current)) {
                current = current[parseInt(index)];
            }
        } else {
            current = current[part];
        }

        // ENHANCED: If current is an array and we have more path parts to traverse
        // Extract the nested property from ALL array elements
        if (Array.isArray(current) && i < parts.length - 1) {
            const remainingPath = parts.slice(i + 1).join('.');
            const nestedValues = current
                .map(item => {
                    if (item === null || item === undefined) return undefined;
                    return getNestedValue(item, remainingPath);
                })
                .filter(val => val !== undefined);

            return nestedValues.length > 0 ? nestedValues : undefined;
        }
    }

    return current;
}

function setNestedValue(obj: any, path: string, value: any): void {
    const parts = path.split('.');
    let current = obj;

    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!(part in current)) {
            current[part] = {};
        }
        current = current[part];
    }

    current[parts[parts.length - 1]] = value;
}

/**
 * Flatten array values for searching and comparison
 */
function flattenValue(value: any): any[] {
    if (value === null || value === undefined) {
        return [];
    }

    if (isFirestoreTimestamp(value)) {
        return [value];
    }

    if (Array.isArray(value)) {
        return value
            .map(item => flattenValue(item))
            .flat()
            .filter(v => v !== null && v !== undefined);
    }

    if (typeof value !== 'object' || value instanceof Date) {
        return [value];
    }

    return [value];
}

/**
 * Compare values with operator support
 */
function compareValues(docValue: any, operator: string, filterValue: any, filterValue2?: any): boolean {
    if (docValue === null || docValue === undefined) {
        return operator === 'ne' || operator === 'lt' || operator === 'lte';
    }

    if (isFirestoreTimestamp(docValue)) {
        docValue = firestoreTimestampToDate(docValue);
    }

    // Handle date comparisons
    if (docValue instanceof Date || typeof filterValue === 'string' && !isNaN(Date.parse(filterValue))) {
        const docDate = docValue instanceof Date ? docValue : new Date(docValue);
        const filterDate = new Date(filterValue);

        switch (operator) {
            case 'eq': return docDate.getTime() === filterDate.getTime();
            case 'ne': return docDate.getTime() !== filterDate.getTime();
            case 'gt': return docDate.getTime() > filterDate.getTime();
            case 'gte': return docDate.getTime() >= filterDate.getTime();
            case 'lt': return docDate.getTime() < filterDate.getTime();
            case 'lte': return docDate.getTime() <= filterDate.getTime();
            case 'between':
                if (filterValue2) {
                    const filterDate2 = new Date(filterValue2);
                    return docDate.getTime() >= filterDate.getTime() && docDate.getTime() <= filterDate2.getTime();
                }
                return false;
        }
    }

    // Handle number comparisons
    if (typeof docValue === 'number' || !isNaN(Number(docValue))) {
        const docNum = typeof docValue === 'number' ? docValue : Number(docValue);
        const filterNum = typeof filterValue === 'number' ? filterValue : Number(filterValue);

        switch (operator) {
            case 'eq': return docNum === filterNum;
            case 'ne': return docNum !== filterNum;
            case 'gt': return docNum > filterNum;
            case 'gte': return docNum >= filterNum;
            case 'lt': return docNum < filterNum;
            case 'lte': return docNum <= filterNum;
            case 'between':
                if (filterValue2 !== undefined) {
                    const filterNum2 = typeof filterValue2 === 'number' ? filterValue2 : Number(filterValue2);
                    return docNum >= filterNum && docNum <= filterNum2;
                }
                return false;
        }
    }

    // Handle string comparisons
    const docStr = String(docValue).toLowerCase();
    const filterStr = String(filterValue).toLowerCase();

    switch (operator) {
        case 'eq': return docStr === filterStr;
        case 'ne': return docStr !== filterStr;
        case 'gt': return docStr > filterStr;
        case 'gte': return docStr >= filterStr;
        case 'lt': return docStr < filterStr;
        case 'lte': return docStr <= filterStr;
        case 'contains': return docStr.includes(filterStr);
        case 'startsWith': return docStr.startsWith(filterStr);
        case 'endsWith': return docStr.endsWith(filterStr);
        case 'in':
            if (Array.isArray(filterValue)) {
                return filterValue.some(v => String(v).toLowerCase() === docStr);
            }
            return false;
    }

    return false;
}

/**
 * Check if a single filter matches the document
 * Enhanced to support array filtering
 */
function matchesSingleFilter(doc: any, filter: FilterCriteria): boolean {
    const fieldValue = getNestedValue(doc, filter.field);

    // Handle arrays - check if ANY element matches
    if (Array.isArray(fieldValue)) {
        const flatValues = flattenValue(fieldValue);
        return flatValues.some(val =>
            compareValues(val, filter.operator, filter.value, filter.value2)
        );
    }

    return compareValues(fieldValue, filter.operator, filter.value, filter.value2);
}

/**
 * Check if document matches filter group with AND/OR logic
 */
function matchesFilterGroup(doc: any, filterGroup: FilterGroup): boolean {
    if (!filterGroup.filters || filterGroup.filters.length === 0) return true;

    const logic = filterGroup.logic || 'and';

    if (logic === 'and') {
        return filterGroup.filters.every(filter => {
            if ('logic' in filter && 'filters' in filter) {
                return matchesFilterGroup(doc, filter as FilterGroup);
            }
            return matchesSingleFilter(doc, filter as FilterCriteria);
        });
    } else {
        return filterGroup.filters.some(filter => {
            if ('logic' in filter && 'filters' in filter) {
                return matchesFilterGroup(doc, filter as FilterGroup);
            }
            return matchesSingleFilter(doc, filter as FilterCriteria);
        });
    }
}

function parseFilters(filters: any): FilterGroup {
    if (!filters) return { logic: 'and', filters: [] };

    if (Array.isArray(filters)) {
        return { logic: 'and', filters };
    }

    if (typeof filters === 'string') {
        try {
            const parsed = JSON.parse(filters);
            if (Array.isArray(parsed)) {
                return { logic: 'and', filters: parsed };
            }
            return parsed;
        } catch {
            return { logic: 'and', filters: [] };
        }
    }

    if (filters.logic && filters.filters) {
        return filters;
    }

    return { logic: 'and', filters: [] };
}

function parseSortCriteria(sortParam: any): SortCriteria[] {
    if (!sortParam) return [];

    if (Array.isArray(sortParam)) {
        return sortParam.map(s => ({
            field: s.field,
            order: s.order || 'asc'
        }));
    }

    if (typeof sortParam === 'string') {
        try {
            const parsed = JSON.parse(sortParam);
            if (Array.isArray(parsed)) {
                return parsed.map(s => ({
                    field: s.field,
                    order: s.order || 'asc'
                }));
            }
            if (parsed.field) {
                return [{
                    field: parsed.field,
                    order: parsed.order || 'asc'
                }];
            }
        } catch {
            return sortParam.split(',').map(s => {
                const [field, order] = s.trim().split(':');
                return {
                    field: field.trim(),
                    order: (order?.trim() as 'asc' | 'desc') || 'asc'
                };
            }).filter(s => s.field);
        }
    }

    if (sortParam.field) {
        return [{
            field: sortParam.field,
            order: sortParam.order || 'asc'
        }];
    }

    return [];
}

function parsePopulateOptions(populateParam: any): PopulateOptions[] {
    if (!populateParam) return [];

    if (Array.isArray(populateParam)) {
        return populateParam.map(p => ({
            field: p.field,
            link: p.link,
            collection: p.collection,
            select: p.select || '*',
            as: p.as || p.field || (p.link ? p.collection : undefined),
            type: p.type,
            populate: p.populate ? parsePopulateOptions(p.populate) : undefined
        }));
    }

    if (typeof populateParam === 'string') {
        try {
            const parsed = JSON.parse(populateParam);
            if (Array.isArray(parsed)) {
                return parsed.map(p => ({
                    field: p.field,
                    link: p.link,
                    collection: p.collection,
                    select: p.select || '*',
                    as: p.as || p.field || (p.link ? p.collection : undefined),
                    type: p.type,
                    populate: p.populate ? parsePopulateOptions(p.populate) : undefined
                }));
            }
            if ((parsed.field || parsed.link) && parsed.collection) {
                return [{
                    field: parsed.field,
                    link: parsed.link,
                    collection: parsed.collection,
                    select: parsed.select || '*',
                    as: parsed.as || parsed.field || (parsed.link ? parsed.collection : undefined),
                    type: parsed.type,
                    populate: parsed.populate ? parsePopulateOptions(parsed.populate) : undefined
                }];
            }
        } catch {
            return [];
        }
    }

    if ((populateParam.field || populateParam.link) && populateParam.collection) {
        return [{
            field: populateParam.field,
            link: populateParam.link,
            collection: populateParam.collection,
            select: populateParam.select || '*',
            as: populateParam.as || populateParam.field || (populateParam.link ? populateParam.collection : undefined),
            type: populateParam.type,
            populate: populateParam.populate ? parsePopulateOptions(populateParam.populate) : undefined
        }];
    }

    return [];
}

function getComparableValue(value: any): any {
    if (value === null || value === undefined) {
        return null;
    }

    if (isFirestoreTimestamp(value)) {
        const date = firestoreTimestampToDate(value);
        return date ? date.getTime() : null;
    }

    if (value instanceof Date) {
        return value.getTime();
    }

    if (typeof value === 'string') {
        return value.toLowerCase();
    }

    return value;
}

function compareSortValues(a: any, b: any, order: 'asc' | 'desc'): number {
    const valA = getComparableValue(a);
    const valB = getComparableValue(b);

    if (valA === null && valB === null) return 0;
    if (valA === null) return 1;
    if (valB === null) return -1;

    let comparison = 0;

    if (typeof valA === 'number' && typeof valB === 'number') {
        comparison = valA - valB;
    } else if (typeof valA === 'string' && typeof valB === 'string') {
        comparison = valA.localeCompare(valB);
    } else {
        comparison = String(valA).localeCompare(String(valB));
    }

    return order === 'desc' ? -comparison : comparison;
}

function sortDocuments(documents: any[], sortCriteria: SortCriteria[]): any[] {
    if (!sortCriteria || sortCriteria.length === 0) {
        return documents;
    }

    return [...documents].sort((a, b) => {
        for (const criteria of sortCriteria) {
            const valueA = getNestedValue(a, criteria.field);
            const valueB = getNestedValue(b, criteria.field);

            const comparison = compareSortValues(valueA, valueB, criteria.order);

            if (comparison !== 0) {
                return comparison;
            }
        }

        return 0;
    });
}

function selectFields(doc: any, select: string | string[]): any {
    if (!doc) return null;

    if (select === '*') {
        return doc;
    }

    const fieldsArray = typeof select === 'string'
        ? select.split(',').map(f => f.trim())
        : select;

    const result: any = { id: doc.id };

    fieldsArray.forEach(field => {
        if (field === '*') {
            return Object.assign(result, doc);
        }

        const value = getNestedValue(doc, field);
        if (value !== undefined) {
            setNestedValue(result, field, value);
        }
    });

    return result;
}

async function performForwardPopulation(documents: any[], option: PopulateOptions): Promise<void> {
    const { field, collection, select, as } = option;

    if (!field) {
        console.error('Forward population requires "field" parameter');
        return;
    }

    const cache: { [id: string]: any } = {};
    const foreignKeysSet = new Set<string>();

    documents.forEach(doc => {
        const foreignKey = getNestedValue(doc, field);

        if (foreignKey) {
            if (Array.isArray(foreignKey)) {
                foreignKey.forEach(fk => {
                    if (fk && typeof fk === 'string') {
                        foreignKeysSet.add(fk);
                    }
                });
            } else if (typeof foreignKey === 'string') {
                foreignKeysSet.add(foreignKey);
            }
        }
    });

    const foreignKeys = Array.from(foreignKeysSet);

    if (foreignKeys.length > 0) {
        const batchSize = 10;
        for (let i = 0; i < foreignKeys.length; i += batchSize) {
            const batch = foreignKeys.slice(i, i + batchSize);

            try {
                const snapshot = await db.collection(collection)
                    .where(admin.firestore.FieldPath.documentId(), 'in', batch)
                    .get();

                snapshot.forEach(doc => {
                    const docData = { id: doc.id, ...doc.data() };
                    cache[doc.id] = selectFields(docData, select || '*');
                });
            } catch (error) {
                console.error(`Error fetching from collection ${collection}:`, error);
            }
        }

        foreignKeys.forEach(fk => {
            if (!cache[fk]) {
                cache[fk] = null;
            }
        });
    }

    documents.forEach(doc => {
        const foreignKey = getNestedValue(doc, field);
        const targetField = as || field;

        if (foreignKey) {
            if (Array.isArray(foreignKey)) {
                const populatedArray = foreignKey
                    .map(fk => cache[fk])
                    .filter(item => item !== null && item !== undefined);

                setNestedValue(doc, targetField, populatedArray);
            } else if (typeof foreignKey === 'string') {
                const populatedDoc = cache[foreignKey];
                setNestedValue(doc, targetField, populatedDoc || null);
            }
        } else {
            setNestedValue(doc, targetField, null);
        }
    });

    if (option.populate && option.populate.length > 0) {
        const targetField = as || field;
        const nestedDocs: any[] = [];

        documents.forEach(doc => {
            const populatedValue = getNestedValue(doc, targetField);
            if (populatedValue) {
                if (Array.isArray(populatedValue)) {
                    nestedDocs.push(...populatedValue.filter(v => v !== null));
                } else if (populatedValue !== null) {
                    nestedDocs.push(populatedValue);
                }
            }
        });

        if (nestedDocs.length > 0) {
            await populateDocuments(nestedDocs, option.populate);
        }
    }
}

async function performReversePopulation(documents: any[], option: PopulateOptions): Promise<void> {
    const { link, collection, select, as } = option;

    if (!link) {
        console.error('Reverse population requires "link" parameter');
        return;
    }

    const documentIds = documents.map(doc => doc.id).filter(id => id);

    if (documentIds.length === 0) {
        return;
    }

    const relatedDocsMap: { [parentId: string]: any[] } = {};
    documents.forEach(doc => {
        relatedDocsMap[doc.id] = [];
    });

    const batchSize = 10;
    for (let i = 0; i < documentIds.length; i += batchSize) {
        const batch = documentIds.slice(i, i + batchSize);

        try {
            const snapshot = await db.collection(collection)
                .where(link, 'in', batch)
                .get();

            snapshot.forEach(doc => {
                const docData: any = { id: doc.id, ...doc.data() };
                const selectedDoc = selectFields(docData, select || '*');
                const parentId = docData[link] as string;

                if (parentId && relatedDocsMap[parentId]) {
                    relatedDocsMap[parentId].push(selectedDoc);
                }
            });
        } catch (error) {
            console.error(`Error performing reverse population from collection ${collection}:`, error);
        }
    }

    try {
        const snapshot = await db.collection(collection).get();

        snapshot.forEach(doc => {
            const docData: any = { id: doc.id, ...doc.data() };
            const linkValue = docData[link];

            if (Array.isArray(linkValue)) {
                const matchingParentIds = documentIds.filter(id => linkValue.includes(id));

                if (matchingParentIds.length > 0) {
                    const selectedDoc = selectFields(docData, select || '*');
                    matchingParentIds.forEach(parentId => {
                        if (relatedDocsMap[parentId]) {
                            const exists = relatedDocsMap[parentId].some(d => d.id === selectedDoc.id);
                            if (!exists) {
                                relatedDocsMap[parentId].push(selectedDoc);
                            }
                        }
                    });
                }
            }
        });
    } catch (error) {
        console.error(`Error checking array fields in reverse population:`, error);
    }

    documents.forEach(doc => {
        const targetField = as || `${collection}`;
        const relatedDocs = relatedDocsMap[doc.id] || [];
        setNestedValue(doc, targetField, relatedDocs);
    });

    if (option.populate && option.populate.length > 0) {
        const targetField = as || `${collection}`;
        const allNestedDocs: any[] = [];

        documents.forEach(doc => {
            const populatedValue = getNestedValue(doc, targetField);
            if (Array.isArray(populatedValue)) {
                allNestedDocs.push(...populatedValue.filter(v => v !== null));
            }
        });

        if (allNestedDocs.length > 0) {
            await populateDocuments(allNestedDocs, option.populate);
        }
    }
}

async function populateDocuments(documents: any[], populateOptions: PopulateOptions[]): Promise<any[]> {
    if (!populateOptions || populateOptions.length === 0) {
        return documents;
    }

    for (const option of populateOptions) {
        const { field, link, type } = option;

        const isReverse = type === 'reverse' || (link && !field);
        const isForward = type === 'forward' || (field && !link);

        if (!isReverse && !isForward) {
            console.error('Population option must have either "field" (forward) or "link" (reverse)');
            continue;
        }

        if (isReverse) {
            await performReversePopulation(documents, option);
        } else {
            await performForwardPopulation(documents, option);
        }
    }

    return documents;
}

function extractSearchableFields(documents: any[], maxDepth: number = 3): string[] {
    const fieldsSet = new Set<string>();

    function extractFields(obj: any, prefix: string = '', depth: number = 0) {
        if (depth > maxDepth || obj === null || obj === undefined) {
            return;
        }

        if (isFirestoreTimestamp(obj)) {
            return;
        }

        Object.keys(obj).forEach(key => {
            const value = obj[key];
            const fullPath = prefix ? `${prefix}.${key}` : key;

            if (key === 'id' || fullPath === 'id' || key.startsWith('_')) {
                return;
            }

            if (isFirestoreTimestamp(value)) {
                return;
            }

            if (
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
            ) {
                fieldsSet.add(fullPath);
            } else if (
                typeof value === 'object' &&
                !Array.isArray(value) &&
                !(value instanceof Date) &&
                !isFirestoreTimestamp(value) &&
                value !== null
            ) {
                extractFields(value, fullPath, depth + 1);
            } else if (Array.isArray(value) && value.length > 0) {
                const hasPrimitives = value.some(item =>
                    typeof item === 'string' ||
                    typeof item === 'number' ||
                    typeof item === 'boolean'
                );

                if (hasPrimitives) {
                    fieldsSet.add(fullPath);
                }

                const objectItems = value.filter(item =>
                    typeof item === 'object' &&
                    item !== null &&
                    !Array.isArray(item) &&
                    !isFirestoreTimestamp(item)
                );

                if (objectItems.length > 0) {
                    objectItems.forEach(item => {
                        extractFields(item, fullPath, depth + 1);
                    });
                }

                const nestedArrays = value.filter(item => Array.isArray(item));
                if (nestedArrays.length > 0) {
                    nestedArrays.forEach(nestedArray => {
                        if (nestedArray.length > 0) {
                            extractFields({ nested: nestedArray[0] }, fullPath, depth + 1);
                        }
                    });
                }
            }
        });
    }

    documents.forEach(doc => extractFields(doc));

    return Array.from(fieldsSet);
}

function calculateRelevanceScore(
    doc: any,
    searchTerms: string[],
    searchableFields: string[],
    fieldWeights: { [key: string]: number }
): number {
    let score = 0;

    searchableFields.forEach(field => {
        const fieldValue = getNestedValue(doc, field);
        const weight = fieldWeights[field] || 1;

        const searchableValues = flattenValue(fieldValue);

        searchableValues.forEach(value => {
            const normalizedValue = String(value).toLowerCase();

            searchTerms.forEach((term, index) => {
                if (normalizedValue === term) {
                    score += 100 * weight;
                } else if (normalizedValue.startsWith(term)) {
                    score += 50 * weight;
                } else if (normalizedValue.includes(term)) {
                    score += 25 * weight;
                }

                const wordBoundaryRegex = new RegExp(`\\b${term}\\b`, 'i');
                if (wordBoundaryRegex.test(normalizedValue)) {
                    score += 15 * weight;
                }

                const positionBonus = (searchTerms.length - index) * 2;
                if (normalizedValue.includes(term)) {
                    score += positionBonus * weight;
                }
            });
        });
    });

    return score;
}

// ============================================================
// MAIN SEARCH DATA FUNCTION
// ============================================================

export const searchData = functions.https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET, POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }

    try {
        const params = req.method === 'POST' ? req.body : req.query;

        const collectionName = (params.collection as string) || COLLECTION;
        let searchQuery = (params.query as string) || (params.q as string);
        const limit = parseInt(params.limit as string) || 50;
        const page = parseInt(params.page as string) || 1;
        const minScore = parseFloat(params.minScore as string) || 0;

        const returnAll = searchQuery === '*';
        if (returnAll) {
            searchQuery = '';
        }

        const filterGroup = parseFilters(params.filters);
        const sortCriteria = parseSortCriteria(params.sort || params.sortBy);
        const populateOptions = parsePopulateOptions(params.populate);
        const specialFilter = parseSpecialFilter(params.specialFilter);
        const specialSort = parseSpecialSort(params.specialSort);

        let customFields = params.fields;
        if (typeof customFields === 'string') {
            customFields = customFields.split(',').map(f => f.trim());
        }

        let fieldWeights: { [key: string]: number } = {};
        if (params.weights) {
            fieldWeights = typeof params.weights === 'string'
                ? JSON.parse(params.weights)
                : params.weights;
        }

        if (page < 1) {
            res.status(400).json({
                success: false,
                error: 'Page number must be greater than 0'
            });
            return;
        }

        // Fetch all documents from collection
        const snapshot = await db.collection(collectionName).get();

        if (snapshot.empty) {
            res.status(200).json({
                success: true,
                message: 'No documents found in collection',
                data: [],
                searchQuery: searchQuery || null,
                searchTerms: searchQuery ? searchQuery.toLowerCase().trim().split(/\s+/) : [],
                totalDocuments: 0,
                filters: filterGroup,
                sort: sortCriteria,
                returnAll,
                specialFilter,
                pagination: {
                    page: 1,
                    limit,
                    totalPages: 0,
                    totalResults: 0,
                    hasNextPage: false,
                    hasPrevPage: false
                }
            });
            return;
        }

        // Convert to array of documents
        const allDocuments: any[] = [];
        snapshot.forEach(doc => {
            allDocuments.push({
                id: doc.id,
                ...doc.data()
            });
        });

        // Apply filters with multi-level array support
        let filteredDocuments = allDocuments;
        if (filterGroup.filters && filterGroup.filters.length > 0) {
            filteredDocuments = allDocuments.filter(doc => matchesFilterGroup(doc, filterGroup));
        }

        // Apply special filters
        if (specialFilter) {
            filteredDocuments = applySpecialFilters(filteredDocuments, specialFilter, collectionName);
        }

        // If no search query (or query is "*"), return filtered and sorted results
        if (!searchQuery || searchQuery.trim().length === 0 || returnAll) {
            // Apply combined sort (special sort as primary, regular sort as tie-breaker)
            const sortedDocuments = applyCombinedSort(
                filteredDocuments,
                specialSort,
                sortCriteria,
                collectionName
            );

            const totalResults = sortedDocuments.length;
            const totalPages = Math.ceil(totalResults / limit);
            const startIndex = (page - 1) * limit;
            const endIndex = startIndex + limit;

            if (page > totalPages && totalResults > 0) {
                res.status(400).json({
                    success: false,
                    error: `Page ${page} does not exist. Total pages: ${totalPages}`
                });
                return;
            }

            const paginatedResults = sortedDocuments.slice(startIndex, endIndex);

            // Remove internal fields unless explicitly requested
            const includeDistance = params.includeDistance === 'true' || params.includeDistance === true;
            let resultsBeforePopulation = paginatedResults.map(doc => {
                // Always remove distanceRaw (internal field)
                const { distanceRaw, ...docWithoutRaw } = doc;

                // Remove distance if not requested
                if (!includeDistance && specialSort?.type === 'distance') {
                    const { distance, ...docWithoutDistance } = docWithoutRaw;
                    return docWithoutDistance;
                }

                return docWithoutRaw;
            });

            const populatedResults = await populateDocuments(resultsBeforePopulation, populateOptions);

            const pagination = {
                page,
                limit,
                totalPages,
                totalResults,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
                nextPage: page < totalPages ? page + 1 : null,
                prevPage: page > 1 ? page - 1 : null,
                startIndex: startIndex + 1,
                endIndex: Math.min(endIndex, totalResults)
            };

            res.status(200).json({
                success: true,
                count: populatedResults.length,
                totalDocuments: allDocuments.length,
                filteredDocuments: filteredDocuments.length,
                filters: filterGroup,
                sort: sortCriteria,
                populate: populateOptions,
                returnAll,
                specialFilter,
                specialSort,
                pagination,
                data: populatedResults
            });
            return;
        }

        // Normalize search query
        const searchTerms = searchQuery
            .toLowerCase()
            .trim()
            .split(/\s+/)
            .filter(term => term.length > 0);

        // Determine searchable fields
        const searchableFields = customFields && customFields.length > 0
            ? customFields
            : extractSearchableFields(filteredDocuments);

        // Calculate relevance score for each filtered document
        const scoredDocuments = filteredDocuments.map(doc => {
            const score = calculateRelevanceScore(
                doc,
                searchTerms,
                searchableFields,
                fieldWeights
            );

            return {
                ...doc,
                _relevanceScore: score
            };
        });

        // Filter by minimum score
        let filteredAndSorted = scoredDocuments
            .filter(doc => doc._relevanceScore > minScore);

        // Apply combined sorting (special sort + regular sort as tie-breaker)
        filteredAndSorted = applyCombinedSort(
            filteredAndSorted,
            specialSort,
            sortCriteria.length > 0 ? sortCriteria : null as any,
            collectionName
        );

        // If no special sort and no regular sort, default to relevance score
        if (!specialSort && (!sortCriteria || sortCriteria.length === 0)) {
            filteredAndSorted = filteredAndSorted.sort((a, b) => b._relevanceScore - a._relevanceScore);
        }

        // Calculate pagination
        const totalResults = filteredAndSorted.length;
        const totalPages = Math.ceil(totalResults / limit);
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;

        if (page > totalPages && totalResults > 0) {
            res.status(400).json({
                success: false,
                error: `Page ${page} does not exist. Total pages: ${totalPages}`
            });
            return;
        }

        // Get paginated results
        const paginatedResults = filteredAndSorted.slice(startIndex, endIndex);

        // Remove score unless explicitly requested
        const includeScore = params.includeScore === 'true' || params.includeScore === true;
        const includeDistance = params.includeDistance === 'true' || params.includeDistance === true;
        let results = paginatedResults;

        if (!includeScore) {
            results = results.map(doc => {
                const { _relevanceScore, ...docWithoutScore } = doc;
                return docWithoutScore;
            });
        }

        if (!includeDistance && specialSort?.type === 'distance') {
            results = results.map(doc => {
                const { distance, ...docWithoutDistance } = doc;
                return docWithoutDistance;
            });
        }

        // Apply population
        results = await populateDocuments(results, populateOptions);

        // Build pagination metadata
        const pagination = {
            page,
            limit,
            totalPages,
            totalResults,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
            nextPage: page < totalPages ? page + 1 : null,
            prevPage: page > 1 ? page - 1 : null,
            startIndex: startIndex + 1,
            endIndex: Math.min(endIndex, totalResults)
        };

        res.status(200).json({
            success: true,
            count: results.length,
            totalDocuments: allDocuments.length,
            filteredDocuments: filteredDocuments.length,
            searchQuery,
            searchTerms,
            searchableFields,
            filters: filterGroup,
            sort: sortCriteria,
            populate: populateOptions,
            specialFilter,
            pagination,
            data: results
        });

    } catch (error: any) {
        console.error('Error searching documents:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});