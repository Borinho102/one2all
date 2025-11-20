import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Reuse the existing helper functions from your search implementation
const db = admin.firestore();

// ============================================================
// HELPER FUNCTIONS (reused from search)
// ============================================================

function isFirestoreTimestamp(value: any): boolean {
    return (
        value !== null &&
        typeof value === 'object' &&
        ('_seconds' in value || 'seconds' in value) &&
        ('_nanoseconds' in value || 'nanoseconds' in value)
    );
}

function getNestedValue(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
        if (current === null || current === undefined) {
            return undefined;
        }

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

        if (Array.isArray(current) && parts.indexOf(part) < parts.length - 1) {
            const remainingPath = parts.slice(parts.indexOf(part) + 1).join('.');
            return current
                .map(item => getNestedValue(item, remainingPath))
                .filter(val => val !== undefined);
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

// ============================================================
// ADVANCED POPULATE INTERFACES
// ============================================================

interface PopulateOptions {
    field?: string;             // Field containing foreign key(s) - for FORWARD population
    link?: string;              // Field in the target collection that references current doc - for REVERSE population
    collection: string;         // Collection to fetch from
    select?: string | string[]; // Fields to return ('*' or array)
    as?: string;               // Rename the populated field
    populate?: PopulateOptions[]; // Nested population (JOIN of JOINs)
    type?: 'forward' | 'reverse'; // Explicitly set population type (auto-detected if not provided)
}

// @ts-ignore
interface FetchOptions {
    collection: string;
    select?: string | string[]; // Fields to return from main collection
    populate?: PopulateOptions[]; // Related collections to join
    limit?: number;
    page?: number;
    sort?: SortCriteria[];
    filters?: FilterGroup;
}

interface SortCriteria {
    field: string;
    order: 'asc' | 'desc';
}

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

// ============================================================
// POPULATION HELPER WITH NESTED SUPPORT
// ============================================================

async function populateDocumentsAdvanced(
    documents: any[],
    populateOptions: PopulateOptions[]
): Promise<any[]> {
    if (!populateOptions || populateOptions.length === 0) {
        return documents;
    }

    for (const option of populateOptions) {
        const { field, link, type } = option;

        // Determine population type
        const isReverse = type === 'reverse' || (link && !field);
        const isForward = type === 'forward' || (field && !link);

        if (!isReverse && !isForward) {
            console.error('Population option must have either "field" (forward) or "link" (reverse)');
            continue;
        }

        if (isReverse) {
            // REVERSE POPULATION: Find documents in target collection that reference current docs
            await performReversePopulation(documents, option);
        } else {
            // FORWARD POPULATION: Follow foreign keys from current docs to target collection
            await performForwardPopulation(documents, option);
        }
    }

    return documents;
}

// Helper function for FORWARD population (existing logic)
async function performForwardPopulation(
    documents: any[],
    option: PopulateOptions
): Promise<void> {
    const { field, collection, select, as } = option;

    if (!field) {
        console.error('Forward population requires "field" parameter');
        return;
    }

    const cache: { [id: string]: any } = {};

    // Collect unique foreign keys
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
        // Fetch documents in batches of 10 (Firestore 'in' query limit)
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

        // Mark keys that weren't found as null
        foreignKeys.forEach(fk => {
            if (!cache[fk]) {
                cache[fk] = null;
            }
        });
    }

    // Populate the documents
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

    // Handle nested population
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
            await populateDocumentsAdvanced(nestedDocs, option.populate);
        }
    }
}

// Helper function for REVERSE population (NEW)
async function performReversePopulation(
    documents: any[],
    option: PopulateOptions
): Promise<void> {
    const { link, collection, select, as } = option;

    if (!link) {
        console.error('Reverse population requires "link" parameter');
        return;
    }

    // Get all document IDs from current documents
    const documentIds = documents.map(doc => doc.id).filter(id => id);

    if (documentIds.length === 0) {
        return;
    }

    // Create a map to store related documents for each parent document
    const relatedDocsMap: { [parentId: string]: any[] } = {};
    documents.forEach(doc => {
        relatedDocsMap[doc.id] = [];
    });

    // Fetch documents from target collection where 'link' field matches any of our document IDs
    // Firestore 'in' query supports up to 10 items, so batch the requests
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

                // Get the parent ID this document references
                const parentId = docData[link] as string;

                if (parentId && relatedDocsMap[parentId]) {
                    relatedDocsMap[parentId].push(selectedDoc);
                }
            });
        } catch (error) {
            console.error(`Error performing reverse population from collection ${collection}:`, error);
        }
    }

    // Also handle array fields in the target collection (e.g., if link field contains array of IDs)
    try {
        const snapshot = await db.collection(collection).get();

        snapshot.forEach(doc => {
            const docData: any = { id: doc.id, ...doc.data() };
            const linkValue = docData[link];

            // Check if link field is an array containing any of our document IDs
            if (Array.isArray(linkValue)) {
                const matchingParentIds = documentIds.filter(id => linkValue.includes(id));

                if (matchingParentIds.length > 0) {
                    const selectedDoc = selectFields(docData, select || '*');
                    matchingParentIds.forEach(parentId => {
                        if (relatedDocsMap[parentId]) {
                            // Avoid duplicates
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

    // Assign the populated arrays to each document
    documents.forEach(doc => {
        const targetField = as || `${collection}`;
        const relatedDocs = relatedDocsMap[doc.id] || [];
        setNestedValue(doc, targetField, relatedDocs);
    });

    // Handle nested population on the reverse-populated documents
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
            await populateDocumentsAdvanced(allNestedDocs, option.populate);
        }
    }
}

// ============================================================
// PARSE HELPERS
// ============================================================

function parsePopulateOptions(populateParam: any): PopulateOptions[] {
    if (!populateParam) return [];

    if (Array.isArray(populateParam)) {
        return populateParam.map(p => ({
            field: p.field,
            link: p.link,
            collection: p.collection,
            select: p.select || '*',
            as: p.as || p.field || (p.link ? p.collection : undefined),
            populate: p.populate ? parsePopulateOptions(p.populate) : undefined,
            type: p.type
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
                    populate: p.populate ? parsePopulateOptions(p.populate) : undefined,
                    type: p.type
                }));
            }
            if ((parsed.field || parsed.link) && parsed.collection) {
                return [{
                    field: parsed.field,
                    link: parsed.link,
                    collection: parsed.collection,
                    select: parsed.select || '*',
                    as: parsed.as || parsed.field || (parsed.link ? parsed.collection : undefined),
                    populate: parsed.populate ? parsePopulateOptions(parsed.populate) : undefined,
                    type: parsed.type
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
            populate: populateParam.populate ? parsePopulateOptions(populateParam.populate) : undefined,
            type: populateParam.type
        }];
    }

    return [];
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

function firestoreTimestampToDate(timestamp: any): Date | null {
    if (!isFirestoreTimestamp(timestamp)) return null;
    const seconds = timestamp._seconds || timestamp.seconds;
    const nanoseconds = timestamp._nanoseconds || timestamp.nanoseconds || 0;
    return new Date(seconds * 1000 + nanoseconds / 1000000);
}

function compareValues(docValue: any, operator: string, filterValue: any, filterValue2?: any): boolean {
    if (docValue === null || docValue === undefined) {
        return operator === 'ne' || operator === 'lt' || operator === 'lte';
    }

    if (isFirestoreTimestamp(docValue)) {
        docValue = firestoreTimestampToDate(docValue);
    }

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

function matchesSingleFilter(doc: any, filter: FilterCriteria): boolean {
    const fieldValue = getNestedValue(doc, filter.field);

    if (Array.isArray(fieldValue)) {
        return fieldValue.some(val =>
            compareValues(val, filter.operator, filter.value, filter.value2)
        );
    }

    return compareValues(fieldValue, filter.operator, filter.value, filter.value2);
}

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

// ============================================================
// MAIN FETCH FUNCTION
// ============================================================

export const fetchCollectionWithRelations = functions.https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET, POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }

    try {
        const params = req.method === 'POST' ? req.body : req.query;

        // Required parameter
        const collectionName = params.collection as string;
        if (!collectionName) {
            res.status(400).json({
                success: false,
                error: 'Collection name is required'
            });
            return;
        }

        // Optional parameters
        const limit = parseInt(params.limit as string) || 100;
        const page = parseInt(params.page as string) || 1;
        const selectFields = params.select;
        const populateOptions = parsePopulateOptions(params.populate);
        const sortCriteria = parseSortCriteria(params.sort);
        const filterGroup = parseFilters(params.filters);

        // Validate page
        if (page < 1) {
            res.status(400).json({
                success: false,
                error: 'Page number must be greater than 0'
            });
            return;
        }

        console.log('Fetching collection:', collectionName);
        console.log('Populate options:', JSON.stringify(populateOptions, null, 2));

        // Fetch all documents from collection
        const snapshot = await db.collection(collectionName).get();

        if (snapshot.empty) {
            res.status(200).json({
                success: true,
                message: 'No documents found in collection',
                collection: collectionName,
                data: [],
                totalDocuments: 0,
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

        // Convert to array
        let documents: any[] = [];
        snapshot.forEach(doc => {
            documents.push({
                id: doc.id,
                ...doc.data()
            });
        });

        const totalDocuments = documents.length;

        // Apply filters
        if (filterGroup.filters && filterGroup.filters.length > 0) {
            documents = documents.filter(doc => matchesFilterGroup(doc, filterGroup));
        }

        const filteredCount = documents.length;

        // Apply sorting
        if (sortCriteria && sortCriteria.length > 0) {
            documents = sortDocuments(documents, sortCriteria);
        }

        // Calculate pagination
        const totalResults = documents.length;
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

        // Paginate
        let paginatedDocs = documents.slice(startIndex, endIndex);

        // Apply field selection to main collection
        if (selectFields) {
            paginatedDocs = paginatedDocs.map(doc => selectFields(doc, selectFields));
        }

        // Populate related collections (with nested support)
        if (populateOptions && populateOptions.length > 0) {
            paginatedDocs = await populateDocumentsAdvanced(paginatedDocs, populateOptions);
        }

        // Build response
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
            collection: collectionName,
            count: paginatedDocs.length,
            totalDocuments,
            filteredDocuments: filteredCount,
            filters: filterGroup,
            sort: sortCriteria,
            populate: populateOptions,
            pagination,
            data: paginatedDocs
        });

    } catch (error: any) {
        console.error('Error fetching collection with relations:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});