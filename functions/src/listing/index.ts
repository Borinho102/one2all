import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Initialize Firebase Admin (only do this once)
admin.initializeApp();

// Get reference to Firestore
const db = admin.firestore();

const COLLECTION = 'services';

// HTTP Cloud Function to get all documents from a collection
export const getData = functions.https.onRequest(async (req, res) => {
    // Enable CORS
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }

    try {
        // Replace COLLECTION with your actual collection name
        const collectionName = (req.query.collection as string) || COLLECTION;

        // Get all documents from the collection
        const snapshot = await db.collection(collectionName).get();

        if (snapshot.empty) {
            res.status(200).json({
                success: true,
                message: 'No documents found',
                data: []
            });
            return;
        }

        // Map documents to array with IDs
        const data: any[] = [];
        snapshot.forEach(doc => {
            data.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.status(200).json({
            success: true,
            count: data.length,
            data: data
        });

    } catch (error: any) {
        console.error('Error getting documents:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Function to get a single document by ID
export const getDocumentById = functions.https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }

    try {
        const collectionName = (req.query.collection as string) || COLLECTION;
        const docId = req.query.id as string;

        if (!docId) {
            res.status(400).json({
                success: false,
                error: 'Document ID is required'
            });
            return;
        }

        const doc = await db.collection(collectionName).doc(docId).get();

        if (!doc.exists) {
            res.status(404).json({
                success: false,
                error: 'Document not found'
            });
            return;
        }

        res.status(200).json({
            success: true,
            data: {
                id: doc.id,
                ...doc.data()
            }
        });

    } catch (error: any) {
        console.error('Error getting document:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Function with filtering and pagination
export const getDataFiltered = functions.https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }

    try {
        const collectionName = (req.query.collection as string) || COLLECTION;
        const limit = parseInt(req.query.limit as string) || 100;
        const orderByField = (req.query.orderBy as string) || 'createdAt';
        const orderDirection = (req.query.order as 'asc' | 'desc') || 'desc';

        let query: admin.firestore.Query = db.collection(collectionName);

        // Add ordering
        query = query.orderBy(orderByField, orderDirection);

        // Add limit
        query = query.limit(limit);

        const snapshot = await query.get();

        const data: any[] = [];
        snapshot.forEach(doc => {
            data.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.status(200).json({
            success: true,
            count: data.length,
            data: data
        });

    } catch (error: any) {
        console.error('Error getting documents:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Helper function to check if value is a Firestore Timestamp
function isFirestoreTimestamp(value: any): boolean {
    return (
        value !== null &&
        typeof value === 'object' &&
        ('_seconds' in value || 'seconds' in value) &&
        ('_nanoseconds' in value || 'nanoseconds' in value)
    );
}

// Helper function to convert Firestore timestamp to Date
function firestoreTimestampToDate(timestamp: any): Date | null {
    if (!isFirestoreTimestamp(timestamp)) return null;
    const seconds = timestamp._seconds || timestamp.seconds;
    const nanoseconds = timestamp._nanoseconds || timestamp.nanoseconds || 0;
    return new Date(seconds * 1000 + nanoseconds / 1000000);
}

// Helper function to parse filter operators
interface FilterCriteria {
    field: string;
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'startsWith' | 'endsWith' | 'between';
    value: any;
    value2?: any; // For 'between' operator
}

interface FilterGroup {
    logic?: 'and' | 'or'; // Default 'and'
    filters: (FilterCriteria | FilterGroup)[];
}

interface SortCriteria {
    field: string;
    order: 'asc' | 'desc';
}

interface PopulateOptions {
    field: string;           // The field in the current document that contains the foreign key(s)
    collection: string;      // The collection to fetch from
    select?: string | string[]; // Fields to return from the foreign document ('*' for all, or array of field names)
    as?: string;            // Optional: rename the populated field (default: uses original field name)
}

function parseFilters(filters: any): FilterGroup {
    if (!filters) return { logic: 'and', filters: [] };

    // If filters is an array, wrap it in an AND group
    if (Array.isArray(filters)) {
        return { logic: 'and', filters };
    }

    // If filters is a string, try to parse it
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

    // If it's already a filter group with logic
    if (filters.logic && filters.filters) {
        return filters;
    }

    return { logic: 'and', filters: [] };
}

// Helper function to check if filters reference populated fields
function checkIfFiltersNeedPopulation(filterGroup: FilterGroup, populateOptions: PopulateOptions[]): boolean {
    if (!populateOptions || populateOptions.length === 0) return false;
    if (!filterGroup.filters || filterGroup.filters.length === 0) return false;

    // Get list of populated field paths
    const populatedFields = populateOptions.map(opt => opt.as || opt.field);

    // Recursively check if any filter references a populated field
    function checkFilters(filters: (FilterCriteria | FilterGroup)[]): boolean {
        return filters.some(filter => {
            if ('logic' in filter && 'filters' in filter) {
                // It's a nested filter group
                return checkFilters((filter as FilterGroup).filters);
            }
            // It's a single filter criteria
            const filterField = (filter as FilterCriteria).field;
            // Check if filter field starts with any populated field path
            return populatedFields.some(popField =>
                filterField === popField || filterField.startsWith(popField + '.')
            );
        });
    }

    return checkFilters(filterGroup.filters);
}

// Helper function to check if sort criteria reference populated fields
function checkIfSortNeedsPopulation(sortCriteria: SortCriteria[], populateOptions: PopulateOptions[]): boolean {
    if (!populateOptions || populateOptions.length === 0) return false;
    if (!sortCriteria || sortCriteria.length === 0) return false;

    const populatedFields = populateOptions.map(opt => opt.as || opt.field);

    return sortCriteria.some(sort =>
        populatedFields.some(popField =>
            sort.field === popField || sort.field.startsWith(popField + '.')
        )
    );
}

// Helper function to parse populate parameters
function parsePopulateOptions(populateParam: any): PopulateOptions[] {
    if (!populateParam) return [];

    // If it's already an array of populate options
    if (Array.isArray(populateParam)) {
        return populateParam.map(p => ({
            field: p.field,
            collection: p.collection,
            select: p.select || '*',
            as: p.as || p.field
        }));
    }

    // If it's a string, try to parse it as JSON
    if (typeof populateParam === 'string') {
        try {
            const parsed = JSON.parse(populateParam);
            if (Array.isArray(parsed)) {
                return parsed.map(p => ({
                    field: p.field,
                    collection: p.collection,
                    select: p.select || '*',
                    as: p.as || p.field
                }));
            }
            // Single populate object
            if (parsed.field && parsed.collection) {
                return [{
                    field: parsed.field,
                    collection: parsed.collection,
                    select: parsed.select || '*',
                    as: parsed.as || parsed.field
                }];
            }
        } catch {
            return [];
        }
    }

    // Single populate object
    if (populateParam.field && populateParam.collection) {
        return [{
            field: populateParam.field,
            collection: populateParam.collection,
            select: populateParam.select || '*',
            as: populateParam.as || populateParam.field
        }];
    }

    return [];
}

// Helper function to select specific fields from a document
function selectFields(doc: any, select: string | string[]): any {
    if (!doc) return null;

    // If select is '*', return all fields
    if (select === '*') {
        return doc;
    }

    // Convert to array if it's a comma-separated string
    const fieldsArray = typeof select === 'string'
        ? select.split(',').map(f => f.trim())
        : select;

    // Create a new object with only selected fields
    const result: any = { id: doc.id }; // Always include the ID

    fieldsArray.forEach(field => {
        if (field === '*') {
            // If any field is '*', return everything
            return Object.assign(result, doc);
        }

        // Support nested field selection with dot notation
        const value = getNestedValue(doc, field);
        if (value !== undefined) {
            // Set the value using dot notation
            setNestedValue(result, field, value);
        }
    });

    return result;
}

// Helper function to set nested field value using dot notation
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

// Helper function to populate foreign fields
async function populateDocuments(documents: any[], populateOptions: PopulateOptions[]): Promise<any[]> {
    if (!populateOptions || populateOptions.length === 0) {
        return documents;
    }

    // Create a cache for fetched documents to avoid duplicate queries
    const cache: { [key: string]: { [id: string]: any } } = {};

    // Process each populate option
    for (const option of populateOptions) {
        const { field, collection, select, as } = option;

        // Initialize cache for this collection
        if (!cache[collection]) {
            cache[collection] = {};
        }

        // Collect all unique foreign keys that need to be fetched
        const foreignKeysSet = new Set<string>();
        documents.forEach(doc => {
            const foreignKey = getNestedValue(doc, field);

            if (foreignKey) {
                // Handle array of foreign keys
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

        // Fetch documents that aren't in cache
        const foreignKeys = Array.from(foreignKeysSet);
        const keysToFetch = foreignKeys.filter(fk => !cache[collection][fk]);

        if (keysToFetch.length > 0) {
            // Firestore 'in' query supports up to 10 items, so we need to batch
            const batchSize = 10;
            for (let i = 0; i < keysToFetch.length; i += batchSize) {
                const batch = keysToFetch.slice(i, i + batchSize);

                try {
                    const snapshot = await db.collection(collection)
                        .where(admin.firestore.FieldPath.documentId(), 'in', batch)
                        .get();

                    snapshot.forEach(doc => {
                        const docData = { id: doc.id, ...doc.data() };
                        cache[collection][doc.id] = selectFields(docData, select || '*');
                    });
                } catch (error) {
                    console.error(`Error fetching from collection ${collection}:`, error);
                }
            }

            // Mark keys that weren't found as null
            keysToFetch.forEach(fk => {
                if (!cache[collection][fk]) {
                    cache[collection][fk] = null;
                }
            });
        }

        // Populate the documents
        documents.forEach(doc => {
            const foreignKey = getNestedValue(doc, field);
            const targetField = as || field;

            if (foreignKey) {
                // Handle array of foreign keys
                if (Array.isArray(foreignKey)) {
                    const populatedArray = foreignKey
                        .map(fk => cache[collection][fk])
                        .filter(item => item !== null && item !== undefined);

                    setNestedValue(doc, targetField, populatedArray);
                } else if (typeof foreignKey === 'string') {
                    // Single foreign key
                    const populatedDoc = cache[collection][foreignKey];
                    setNestedValue(doc, targetField, populatedDoc || null);
                }
            } else {
                // Set to null if no foreign key exists
                setNestedValue(doc, targetField, null);
            }
        });
    }

    return documents;
}

function parseSortCriteria(sortParam: any): SortCriteria[] {
    if (!sortParam) return [];

    // If it's already an array of sort criteria
    if (Array.isArray(sortParam)) {
        return sortParam.map(s => ({
            field: s.field,
            order: s.order || 'asc'
        }));
    }

    // If it's a string, parse it
    if (typeof sortParam === 'string') {
        try {
            // Try parsing as JSON first
            const parsed = JSON.parse(sortParam);
            if (Array.isArray(parsed)) {
                return parsed.map(s => ({
                    field: s.field,
                    order: s.order || 'asc'
                }));
            }
            // Single sort object
            if (parsed.field) {
                return [{
                    field: parsed.field,
                    order: parsed.order || 'asc'
                }];
            }
        } catch {
            // Parse as comma-separated format: "field1:asc,field2:desc"
            return sortParam.split(',').map(s => {
                const [field, order] = s.trim().split(':');
                return {
                    field: field.trim(),
                    order: (order?.trim() as 'asc' | 'desc') || 'asc'
                };
            }).filter(s => s.field);
        }
    }

    // Single sort object
    if (sortParam.field) {
        return [{
            field: sortParam.field,
            order: sortParam.order || 'asc'
        }];
    }

    return [];
}

// Helper function to get comparable value for sorting
function getComparableValue(value: any): any {
    if (value === null || value === undefined) {
        return null;
    }

    // Convert Firestore timestamps to Date
    if (isFirestoreTimestamp(value)) {
        const date = firestoreTimestampToDate(value);
        return date ? date.getTime() : null;
    }

    // Convert dates to timestamps
    if (value instanceof Date) {
        return value.getTime();
    }

    // For strings, convert to lowercase for case-insensitive sorting
    if (typeof value === 'string') {
        return value.toLowerCase();
    }

    return value;
}

// Helper function to compare two values for sorting
function compareSortValues(a: any, b: any, order: 'asc' | 'desc'): number {
    const valA = getComparableValue(a);
    const valB = getComparableValue(b);

    // Handle null/undefined values (push to end)
    if (valA === null && valB === null) return 0;
    if (valA === null) return 1;
    if (valB === null) return -1;

    let comparison = 0;

    if (typeof valA === 'number' && typeof valB === 'number') {
        comparison = valA - valB;
    } else if (typeof valA === 'string' && typeof valB === 'string') {
        comparison = valA.localeCompare(valB);
    } else {
        // Fallback for mixed types
        comparison = String(valA).localeCompare(String(valB));
    }

    return order === 'desc' ? -comparison : comparison;
}

// Helper function to sort documents by multiple criteria
function sortDocuments(documents: any[], sortCriteria: SortCriteria[]): any[] {
    if (!sortCriteria || sortCriteria.length === 0) {
        return documents;
    }

    return [...documents].sort((a, b) => {
        for (const criteria of sortCriteria) {
            const valueA = getNestedValue(a, criteria.field);
            const valueB = getNestedValue(b, criteria.field);

            const comparison = compareSortValues(valueA, valueB, criteria.order);

            // If values are different, return the comparison result
            if (comparison !== 0) {
                return comparison;
            }

            // If values are equal, continue to next sort criteria
        }

        // All sort criteria resulted in equality
        return 0;
    });
}

// Helper function to compare values based on operator
function compareValues(docValue: any, operator: string, filterValue: any, filterValue2?: any): boolean {
    // Handle null/undefined
    if (docValue === null || docValue === undefined) {
        return operator === 'ne' || operator === 'lt' || operator === 'lte';
    }

    // Convert Firestore timestamps to Date for comparison
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

// Helper function to check if document matches filters with AND/OR logic
function matchesFilterGroup(doc: any, filterGroup: FilterGroup): boolean {
    if (!filterGroup.filters || filterGroup.filters.length === 0) return true;

    const logic = filterGroup.logic || 'and';

    if (logic === 'and') {
        // ALL filters must match
        return filterGroup.filters.every(filter => {
            // Check if it's a nested filter group
            if ('logic' in filter && 'filters' in filter) {
                return matchesFilterGroup(doc, filter as FilterGroup);
            }
            // It's a single filter criteria
            return matchesSingleFilter(doc, filter as FilterCriteria);
        });
    } else {
        // ANY filter must match (OR)
        return filterGroup.filters.some(filter => {
            // Check if it's a nested filter group
            if ('logic' in filter && 'filters' in filter) {
                return matchesFilterGroup(doc, filter as FilterGroup);
            }
            // It's a single filter criteria
            return matchesSingleFilter(doc, filter as FilterCriteria);
        });
    }
}

// Helper function to check single filter criteria
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

// Helper function to check if document matches all filters (legacy support)
// @ts-ignore
function matchesFilters(doc: any, filters: FilterCriteria[]): boolean {
    if (!filters || filters.length === 0) return true;

    return filters.every(filter => matchesSingleFilter(doc, filter));
}

// Helper function to get nested field value using dot notation (supports arrays)
function getNestedValue(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
        if (current === null || current === undefined) {
            return undefined;
        }

        // Handle array notation (e.g., "items[0].name" or just "items")
        const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);

        if (arrayMatch) {
            // Extract array name and index
            const [, arrayName, index] = arrayMatch;
            current = current[arrayName];
            if (Array.isArray(current)) {
                current = current[parseInt(index)];
            }
        } else {
            current = current[part];
        }

        // If current is an array and we haven't reached the end, search all elements
        if (Array.isArray(current) && parts.indexOf(part) < parts.length - 1) {
            const remainingPath = parts.slice(parts.indexOf(part) + 1).join('.');
            // Recursively get values from all array elements
            return current
                .map(item => getNestedValue(item, remainingPath))
                .filter(val => val !== undefined);
        }
    }

    return current;
}

// Helper function to flatten array values for searching
function flattenValue(value: any): string[] {
    if (value === null || value === undefined) {
        return [];
    }

    // Skip Firestore timestamps
    if (isFirestoreTimestamp(value)) {
        return [];
    }

    if (Array.isArray(value)) {
        return value
            .map(item => flattenValue(item))
            .flat()
            .filter(Boolean);
    }

    if (typeof value === 'object' && !(value instanceof Date)) {
        // Skip objects that look like Firestore timestamps
        if (isFirestoreTimestamp(value)) {
            return [];
        }
        return Object.values(value)
            .map(v => flattenValue(v))
            .flat()
            .filter(Boolean);
    }

    return [String(value)];
}

// Helper function to calculate relevance score
function calculateRelevanceScore(
    doc: any,
    searchTerms: string[],
    searchableFields: string[],
    fieldWeights: { [key: string]: number }
): number {
    let score = 0;

    searchableFields.forEach(field => {
        // Support nested fields with dot notation (e.g., "address.city", "items[0].name")
        const fieldValue = getNestedValue(doc, field);
        const weight = fieldWeights[field] || 1;

        // Flatten array values into searchable strings
        const searchableValues = flattenValue(fieldValue);

        searchableValues.forEach(value => {
            const normalizedValue = String(value).toLowerCase();

            searchTerms.forEach((term, index) => {
                // Exact match gets highest score
                if (normalizedValue === term) {
                    score += 100 * weight;
                }
                // Starts with term
                else if (normalizedValue.startsWith(term)) {
                    score += 50 * weight;
                }
                // Contains term
                else if (normalizedValue.includes(term)) {
                    score += 25 * weight;
                }

                // Word boundary match (term appears as a separate word)
                const wordBoundaryRegex = new RegExp(`\\b${term}\\b`, 'i');
                if (wordBoundaryRegex.test(normalizedValue)) {
                    score += 15 * weight;
                }

                // Bonus for matching earlier terms (position matters)
                const positionBonus = (searchTerms.length - index) * 2;
                if (normalizedValue.includes(term)) {
                    score += positionBonus * weight;
                }
            });
        });
    });

    return score;
}

// Helper function to extract all searchable fields from documents (including nested arrays)
function extractSearchableFields(documents: any[], maxDepth: number = 3): string[] {
    const fieldsSet = new Set<string>();

    function extractFields(obj: any, prefix: string = '', depth: number = 0) {
        if (depth > maxDepth || obj === null || obj === undefined) {
            return;
        }

        // Skip Firestore timestamps
        if (isFirestoreTimestamp(obj)) {
            return;
        }

        Object.keys(obj).forEach(key => {
            const value = obj[key];
            const fullPath = prefix ? `${prefix}.${key}` : key;

            // Skip id field and Firestore internal fields
            if (key === 'id' || fullPath === 'id' || key.startsWith('_')) {
                return;
            }

            // Skip Firestore timestamps
            if (isFirestoreTimestamp(value)) {
                return;
            }

            // If it's a primitive value, add it
            if (
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
            ) {
                fieldsSet.add(fullPath);
            }
            // If it's an object (but not array or date or timestamp), recurse
            else if (
                typeof value === 'object' &&
                !Array.isArray(value) &&
                !(value instanceof Date) &&
                !isFirestoreTimestamp(value) &&
                value !== null
            ) {
                extractFields(value, fullPath, depth + 1);
            }
            // If it's an array, handle array elements
            else if (Array.isArray(value) && value.length > 0) {
                // Add the array field itself if it contains primitives
                const hasPrimitives = value.some(item =>
                    typeof item === 'string' ||
                    typeof item === 'number' ||
                    typeof item === 'boolean'
                );

                if (hasPrimitives) {
                    fieldsSet.add(fullPath);
                }

                // Check all unique object structures in the array
                const objectItems = value.filter(item =>
                    typeof item === 'object' &&
                    item !== null &&
                    !Array.isArray(item) &&
                    !isFirestoreTimestamp(item)
                );

                if (objectItems.length > 0) {
                    // Extract fields from array objects (e.g., "items.name", "items.price")
                    objectItems.forEach(item => {
                        extractFields(item, fullPath, depth + 1);
                    });
                }

                // Handle nested arrays
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

// Advanced search function with relevance ranking, pagination, filters, and sorting
export const searchData = functions.https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET, POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }

    try {
        // Support both GET and POST methods
        const params = req.method === 'POST' ? req.body : req.query;

        const collectionName = (params.collection as string) || COLLECTION;
        let searchQuery = (params.query as string) || (params.q as string);
        const limit = parseInt(params.limit as string) || 50;
        const page = parseInt(params.page as string) || 1;
        const minScore = parseFloat(params.minScore as string) || 0;

        // Check if query is "*" (return all)
        const returnAll = searchQuery === '*';
        if (returnAll) {
            searchQuery = ''; // Clear query to skip search logic
        }

        // Parse filters with AND/OR support
        const filterGroup = parseFilters(params.filters);

        // Parse sort criteria
        const sortCriteria = parseSortCriteria(params.sort || params.sortBy);

        // Parse populate options
        const populateOptions = parsePopulateOptions(params.populate);

        // Check if any filters reference populated fields
        // @ts-ignore
        const needsEarlyPopulation = checkIfFiltersNeedPopulation(filterGroup, populateOptions);

        // Check if sort criteria reference populated fields
        // @ts-ignore
        const sortNeedsPopulation = checkIfSortNeedsPopulation(sortCriteria, populateOptions);

        // Optional: custom fields to search (comma-separated string or array)
        let customFields = params.fields;
        if (typeof customFields === 'string') {
            customFields = customFields.split(',').map(f => f.trim());
        }

        // Optional: field weights (JSON object as string or object)
        let fieldWeights: { [key: string]: number } = {};
        if (params.weights) {
            fieldWeights = typeof params.weights === 'string'
                ? JSON.parse(params.weights)
                : params.weights;
        }

        // Validate page number
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

        // Apply filters first
        let filteredDocuments = allDocuments;
        if (filterGroup.filters && filterGroup.filters.length > 0) {
            filteredDocuments = allDocuments.filter(doc => matchesFilterGroup(doc, filterGroup));
        }

        // If no search query (or query is "*"), return filtered and sorted results
        if (!searchQuery || searchQuery.trim().length === 0 || returnAll) {
            // Apply sorting
            const sortedDocuments = sortDocuments(filteredDocuments, sortCriteria);

            // Calculate pagination for filtered results
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

            // Populate foreign fields if requested
            const populatedResults = await populateDocuments(paginatedResults, populateOptions);

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
                pagination,
                data: populatedResults
            });
            return;
        }

        // Normalize search query: lowercase and split into terms
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

        // Apply sorting: if sort criteria provided, use that; otherwise sort by relevance
        if (sortCriteria && sortCriteria.length > 0) {
            filteredAndSorted = sortDocuments(filteredAndSorted, sortCriteria);
        } else {
            // Default to sorting by relevance score
            filteredAndSorted = filteredAndSorted.sort((a, b) => b._relevanceScore - a._relevanceScore);
        }

        // Calculate pagination
        const totalResults = filteredAndSorted.length;
        const totalPages = Math.ceil(totalResults / limit);
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;

        // Check if page is out of range
        if (page > totalPages && totalResults > 0) {
            res.status(400).json({
                success: false,
                error: `Page ${page} does not exist. Total pages: ${totalPages}`
            });
            return;
        }

        // Get paginated results
        const paginatedResults = filteredAndSorted.slice(startIndex, endIndex);

        // Populate foreign fields if requested
        let results = paginatedResults;

        // Remove score from results unless explicitly requested
        const includeScore = params.includeScore === 'true' || params.includeScore === true;
        if (!includeScore) {
            results = results.map(doc => {
                const { _relevanceScore, ...docWithoutScore } = doc;
                return docWithoutScore;
            });
        }

        // Apply population after removing scores
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