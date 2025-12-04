import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { Request, Response } from "express";
import config from '../../config';

// Ensure admin is initialized if not already done elsewhere
if (admin.apps.length === 0) {
    admin.initializeApp();
}

// ============ Interfaces ============

interface NotificationRequest {
    userId?: string;
    title: string;
    body: string;
    data?: Record<string, string>;
    topic?: string;
}

interface NotificationResponse {
    success: boolean;
    messageId: string;
    timestamp: string;
    debug?: {
        functionName: string;
        executionTime: number;
        region: string;
        [key: string]: any;
    };
}

interface UserDocument {
    fcm_token: string;
    email?: string;
    createdAt?: admin.firestore.Timestamp;
    [key: string]: any;
}

interface NotificationLog {
    userId?: string;
    topic?: string;
    title: string;
    body: string;
    data?: Record<string, any>;
    createdAt: string;
    read: boolean;
}

const persistNotification = async (
    title: string,
    body: string,
    data: Record<string, string>,
    userId?: string,
    topic?: string
): Promise<void> => {
    try {
        const notificationData: NotificationLog = {
            title,
            body,
            data,
            createdAt: new Date().toISOString(),
            read: false, // Default to unread
        };

        if (userId) {
            notificationData.userId = userId;
            await admin.firestore().collection("notifications")
                .add(notificationData);
        }
        else if (topic) {
            notificationData.topic = topic;
            // Store topic messages in a general collection since they don't belong to one specific ID
            await admin.firestore().collection("alerts")
                .add(notificationData);
        }
    } catch (error) {
        logger.error("Failed to persist notification to Firestore", error);
        // We do not throw here because we don't want to fail the API call
        // just because the DB save failed, as long as FCM sent successfully.
    }
};

// ============ Types ============

type NotificationCallableData = NotificationRequest & { apiKey?: string };

// ============ Configuration ============

const INCLUDE_DEBUG_INFO = true;
const VERBOSE_DEBUG = true;

// ============ Utilities ============

const logger = functions.logger;

const getTimestamp = (): string => new Date().toISOString();

const maskValue = (value: string | undefined): string => {
    if (!value) return "EMPTY/UNDEFINED";
    if (value.length <= 15) return value;
    return `${value.substring(0, 10)}...${value.substring(value.length - 5)}`;
};

const getDebugInfo = () => {
    return {
        timestamp: getTimestamp(),
        config: {
            loaded: !!config,
            hasNotificationKey: !!config?.notification,
            hasApiKey: !!config?.notification?.apiKey,
            apiKeyExists: !!config?.notification?.apiKey,
            apiKeyLength: config?.notification?.apiKey?.length || 0,
            apiKeyMasked: maskValue(config?.notification?.apiKey),
        },
        environment: {
            nodeEnv: process.env.NODE_ENV,
            hasEnvFile: !!process.env.NOTIFICATION_API_KEY,
            envKeyLength: process.env.NOTIFICATION_API_KEY?.length || 0,
            envKeyMasked: maskValue(process.env.NOTIFICATION_API_KEY),
        },
        runtime: {
            functionName: (functions as any).context?.eventId ? "running" : "local",
            region: process.env.FUNCTION_REGION || "unknown",
        },
    };
};

const buildDebugResponse = (
    includeDebug: boolean = INCLUDE_DEBUG_INFO,
    verbose: boolean = VERBOSE_DEBUG
) => {
    if (!includeDebug) return undefined;

    const debug = getDebugInfo();

    if (!verbose) {
        return {
            timestamp: debug.timestamp,
            environment: debug.environment.nodeEnv,
            region: debug.runtime.region,
        };
    }
    return debug;
};

const validateNotificationRequest = (data: any): NotificationRequest => {
    if (!data.title || typeof data.title !== "string") {
        throw new functions.https.HttpsError(
            "invalid-argument",
            "Title is required and must be a string"
        );
    }

    if (!data.body || typeof data.body !== "string") {
        throw new functions.https.HttpsError(
            "invalid-argument",
            "Body is required and must be a string"
        );
    }

    if (!data.userId && !data.topic) {
        throw new functions.https.HttpsError(
            "invalid-argument",
            "Either userId or topic must be provided"
        );
    }

    if (data.userId && typeof data.userId !== "string") {
        throw new functions.https.HttpsError(
            "invalid-argument",
            "userId must be a string"
        );
    }

    if (data.topic && typeof data.topic !== "string") {
        throw new functions.https.HttpsError(
            "invalid-argument",
            "topic must be a string"
        );
    }

    if (data.data && typeof data.data !== "object") {
        throw new functions.https.HttpsError(
            "invalid-argument",
            "data must be an object"
        );
    }

    return {
        userId: data.userId,
        title: data.title.trim(),
        body: data.body.trim(),
        data: data.data || {},
        topic: data.topic,
    };
};

const getUserFCMToken = async (userId: string): Promise<string> => {
    const userDoc = await admin
        .firestore()
        .collection("users")
        .doc(userId)
        .get();

    if (!userDoc.exists) {
        throw new functions.https.HttpsError(
            "not-found",
            `User with id ${userId} not found`
        );
    }

    const userData = userDoc.data() as UserDocument | undefined;

    // console.log("User Data", userData)

    const fcmToken = userData?.fcm_token;

    if (!fcmToken) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            "User FCM token is not available. User may not have app installed or hasn't granted permission."
        );
    }

    return fcmToken;
};

// ============ CORE SENDING FUNCTIONS ============


const sendNotificationToTopic = async (
    title: string,
    body: string,
    customData: Record<string, string>,
    topic: string
): Promise<string> => {

    // 1. Send to FCM
    const message: admin.messaging.Message = {
        notification: {
            title,
            body,
        },
        data: customData,
        topic,
    };

    logger.info(`Sending notification to topic: ${topic}`);
    const messageId = await admin.messaging().send(message);

    // 2. Persist to DB (Fire and forget, or await if strict consistency needed)
    await persistNotification(title, body, customData, undefined, topic);

    return messageId;
};

// Internal function - used by other endpoints
export const sendNotificationToUserInternal = async (
    title: string,
    body: string,
    customData: Record<string, string>,
    userId: string
): Promise<string> => {
    const fcmToken = await getUserFCMToken(userId);

    const message: admin.messaging.Message = {
        notification: {
            title,
            body,
        },
        data: customData,
        token: fcmToken,
    };

    logger.info(`Sending notification to user: ${userId}`);

    try {
        // Run FCM send and DB save in parallel for performance
        const [messageId] = await Promise.all([
            admin.messaging().send(message),
            persistNotification(title, body, customData, userId)
        ]);

        return messageId;
    } catch (error: any) {
        // Handle Invalid Token Error
        if (error.code === 'messaging/registration-token-not-registered' ||
            error.code === 'messaging/invalid-registration-token') {

            logger.warn(`❌ Invalid FCM Token for user ${userId}. Removing token from DB.`);

            // Clean up the invalid token
            await admin.firestore()
                .collection("users")
                .doc(userId)
                .update({
                    fcm_token: admin.firestore.FieldValue.delete(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

            // OPTIONAL: Still persist the notification even if the push failed?
            // Usually, if they uninstalled, we don't save it.
            // If you WANT to save it anyway (so they see it if they reinstall), uncomment below:
            // await persistNotification(title, body, customData, userId);

            throw new functions.https.HttpsError(
                "not-found",
                "User's notification token is no longer valid (App may be uninstalled)."
            );
        }

        // Re-throw other errors
        throw error;
    }
};

// ============ Callable Function ============

export const sendNotificationCallable = functions.https.onCall(
    async (request: any) => {
        const startTime = Date.now();

        try {
            const data = request.data as NotificationCallableData;
            const auth = request.auth;

            // Check authentication
            if (!auth) {
                throw new functions.https.HttpsError(
                    "unauthenticated",
                    "User must be authenticated"
                );
            }

            // Validate request
            const validatedRequest = validateNotificationRequest(data);

            let messageId: string;

            if (validatedRequest.topic) {
                messageId = await sendNotificationToTopic(
                    validatedRequest.title,
                    validatedRequest.body,
                    validatedRequest.data || {},
                    validatedRequest.topic
                );
            } else if (validatedRequest.userId) {
                messageId = await sendNotificationToUserInternal(
                    validatedRequest.title,
                    validatedRequest.body,
                    validatedRequest.data || {},
                    validatedRequest.userId
                );
            } else {
                throw new functions.https.HttpsError(
                    "invalid-argument",
                    "Either userId or topic must be provided"
                );
            }

            const executionTime = Date.now() - startTime;

            const response: NotificationResponse = {
                success: true,
                messageId,
                timestamp: getTimestamp(),
            };

            if (INCLUDE_DEBUG_INFO) {
                response.debug = {
                    functionName: "sendNotificationCallable",
                    executionTime,
                    region: process.env.FUNCTION_REGION || "unknown",
                    ...(VERBOSE_DEBUG && buildDebugResponse(true, true)),
                };
            }

            logger.info("Notification sent successfully", response);
            return response;
        } catch (error) {
            const executionTime = Date.now() - startTime;
            logger.error("Error sending notification:", error);

            if (error instanceof functions.https.HttpsError) {
                const errorResponse: any = {
                    success: false,
                    code: error.code,
                    message: error.message,
                    timestamp: getTimestamp(),
                };

                if (INCLUDE_DEBUG_INFO) {
                    errorResponse.debug = {
                        functionName: "sendNotificationCallable",
                        executionTime,
                        region: process.env.FUNCTION_REGION || "unknown",
                        ...(VERBOSE_DEBUG && buildDebugResponse(true, true)),
                    };
                }

                throw new functions.https.HttpsError(error.code, JSON.stringify(errorResponse));
            }

            throw new functions.https.HttpsError(
                "internal",
                "Failed to send notification"
            );
        }
    }
);

// HTTP Endpoint wrapper for /notify-user
export const sendNotificationToUser = functions.https.onRequest(
    async (req: Request, res: Response): Promise<void> => {
        const startTime = Date.now();

        try {
            // Set CORS headers
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
            res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

            if (req.method === "OPTIONS") {
                res.status(204).send("");
                return;
            }

            if (req.method !== "POST") {
                res.status(405).json({
                    error: "Method not allowed",
                    timestamp: getTimestamp(),
                    ...(INCLUDE_DEBUG_INFO && { debug: buildDebugResponse() }),
                });
                return;
            }

            // Validate request
            const request = validateNotificationRequest(req.body);

            if (!request.userId) {
                res.status(400).json({
                    error: "userId is required for /notify-user endpoint",
                    timestamp: getTimestamp(),
                    ...(INCLUDE_DEBUG_INFO && { debug: buildDebugResponse() }),
                });
                return;
            }

            const messageId = await sendNotificationToUserInternal(
                request.title,
                request.body,
                request.data || {},
                request.userId
            );

            const executionTime = Date.now() - startTime;

            const response: NotificationResponse = {
                success: true,
                messageId,
                timestamp: getTimestamp(),
            };

            if (INCLUDE_DEBUG_INFO) {
                response.debug = {
                    functionName: "sendNotificationToUser",
                    executionTime,
                    region: process.env.FUNCTION_REGION || "unknown",
                    ...(VERBOSE_DEBUG && buildDebugResponse(true, true)),
                };
            }

            logger.info("HTTP user notification sent successfully", response);
            res.json(response);
        } catch (error) {
            const executionTime = Date.now() - startTime;
            logger.error("HTTP /notify-user endpoint error:", error);

            const baseError = {
                success: false,
                timestamp: getTimestamp(),
                ...(INCLUDE_DEBUG_INFO && {
                    debug: {
                        functionName: "sendNotificationToUser",
                        executionTime,
                        region: process.env.FUNCTION_REGION || "unknown",
                    },
                }),
            };

            if (error instanceof functions.https.HttpsError) {
                res.status(400).json({
                    ...baseError,
                    error: error.message,
                    code: error.code,
                });
                return;
            }

            res.status(500).json({
                ...baseError,
                error: "Internal server error",
            });
        }
    }
);

// ============ HTTP Endpoint ============

export const sendNotification = functions.https.onRequest(
    async (req: Request, res: Response): Promise<void> => {
        const startTime = Date.now();

        try {
            // Set CORS headers
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
            res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

            if (req.method === "OPTIONS") {
                res.status(204).send("");
                return;
            }

            if (req.method !== "POST") {
                res.status(405).json({
                    error: "Method not allowed",
                    timestamp: getTimestamp(),
                    ...(INCLUDE_DEBUG_INFO && { debug: buildDebugResponse() }),
                });
                return;
            }

            // API Key validation
            const validApiKey = config.notification.apiKey;
            const authHeader = req.headers.authorization as string;
            const providedApiKey = authHeader?.replace("Bearer ", "");

            if (!providedApiKey || providedApiKey !== validApiKey) {
                logger.warn("❌ Unauthorized API request - Key mismatch");
                const executionTime = Date.now() - startTime;

                res.status(401).json({
                    success: false,
                    error: "Unauthorized",
                    timestamp: getTimestamp(),
                    ...(INCLUDE_DEBUG_INFO && {
                        debug: {
                            functionName: "sendNotification",
                            executionTime,
                            message: "API key validation failed"
                        },
                    }),
                });
                return;
            }

            // Validate request
            const request = validateNotificationRequest(req.body);

            let messageId: string;

            if (request.topic) {
                messageId = await sendNotificationToTopic(
                    request.title,
                    request.body,
                    request.data || {},
                    request.topic
                );
            } else if (request.userId) {
                messageId = await sendNotificationToUserInternal(
                    request.title,
                    request.body,
                    request.data || {},
                    request.userId
                );
            } else {
                res.status(400).json({
                    error: "Either userId or topic must be provided",
                    timestamp: getTimestamp(),
                    ...(INCLUDE_DEBUG_INFO && { debug: buildDebugResponse() }),
                });
                return;
            }

            const executionTime = Date.now() - startTime;

            const response: NotificationResponse = {
                success: true,
                messageId,
                timestamp: getTimestamp(),
            };

            if (INCLUDE_DEBUG_INFO) {
                response.debug = {
                    functionName: "sendNotification",
                    executionTime,
                    region: process.env.FUNCTION_REGION || "unknown",
                    ...(VERBOSE_DEBUG && buildDebugResponse(true, true)),
                };
            }

            logger.info("HTTP notification sent successfully", response);
            res.json(response);
        } catch (error) {
            const executionTime = Date.now() - startTime;
            logger.error("HTTP endpoint error:", error);

            const baseError = {
                success: false,
                timestamp: getTimestamp(),
                ...(INCLUDE_DEBUG_INFO && {
                    debug: {
                        functionName: "sendNotification",
                        executionTime,
                        region: process.env.FUNCTION_REGION || "unknown",
                    },
                }),
            };

            if (error instanceof functions.https.HttpsError) {
                res.status(400).json({
                    ...baseError,
                    error: error.message,
                    code: error.code,
                });
                return;
            }

            res.status(500).json({
                ...baseError,
                error: "Internal server error",
            });
        }
    }
);

// ============ Batch Notification Function ============

interface BatchNotificationRequest {
    userIds?: string[];
    topic?: string;
    title: string;
    body: string;
    data?: Record<string, string>;
}

interface BatchNotificationResponse {
    success: boolean;
    sent: number;
    failed: number;
    timestamp: string;
    debug?: {
        functionName: string;
        executionTime: number;
        region: string;
        [key: string]: any;
    };
}

export const sendBatchNotifications = functions.https.onCall(
    async (request: any) => {
        const startTime = Date.now();

        try {
            const data = request.data as BatchNotificationRequest;
            const auth = request.auth;

            if (!auth) {
                throw new functions.https.HttpsError(
                    "unauthenticated",
                    "User must be authenticated"
                );
            }

            const { userIds, topic, title, body, data: customData } = data;

            if (!title || !body) {
                throw new functions.https.HttpsError(
                    "invalid-argument",
                    "Title and body are required"
                );
            }

            let sent = 0;
            let failed = 0;

            if (topic) {
                await sendNotificationToTopic(title, body, customData || {}, topic);
                sent = 1;
            } else if (userIds && userIds.length > 0) {
                const results = await Promise.allSettled(
                    userIds.map((userId) =>
                        sendNotificationToUserInternal(title, body, customData || {}, userId)
                    )
                );

                sent = results.filter((r) => r.status === "fulfilled").length;
                failed = results.filter((r) => r.status === "rejected").length;

                logger.info(`Batch sent: ${sent}, failed: ${failed}`);
            } else {
                throw new functions.https.HttpsError(
                    "invalid-argument",
                    "Either userIds or topic must be provided"
                );
            }

            const executionTime = Date.now() - startTime;

            const response: BatchNotificationResponse = {
                success: true,
                sent,
                failed,
                timestamp: getTimestamp(),
            };

            if (INCLUDE_DEBUG_INFO) {
                response.debug = {
                    functionName: "sendBatchNotifications",
                    executionTime,
                    region: process.env.FUNCTION_REGION || "unknown",
                    recipientCount: userIds?.length || 1,
                    ...(VERBOSE_DEBUG && buildDebugResponse(true, true)),
                };
            }

            return response;
        } catch (error) {
            const executionTime = Date.now() - startTime;
            logger.error("Batch notification error:", error);

            const errorResponse: any = {
                success: false,
                sent: 0,
                failed: 0,
                timestamp: getTimestamp(),
            };

            if (INCLUDE_DEBUG_INFO) {
                errorResponse.debug = {
                    functionName: "sendBatchNotifications",
                    executionTime,
                    region: process.env.FUNCTION_REGION || "unknown",
                };
            }

            if (error instanceof functions.https.HttpsError) {
                throw new functions.https.HttpsError(error.code, JSON.stringify(errorResponse));
            }

            throw new functions.https.HttpsError(
                "internal",
                JSON.stringify(errorResponse)
            );
        }
    }
);