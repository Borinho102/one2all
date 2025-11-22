import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { Request, Response } from "express";
import config from '../../config';

// admin.initializeApp();

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

// ============ Types ============

type NotificationCallableData = NotificationRequest & { apiKey?: string };

// ============ Configuration ============

// Control debug info in responses - always include full verbose debug
const INCLUDE_DEBUG_INFO = true;
const VERBOSE_DEBUG = true;

// ============ Utilities ============

const logger = functions.logger;

const getTimestamp = (): string => new Date().toISOString();

/**
 * Helper to mask sensitive values for logging
 * Shows first 10 and last 5 chars, hides middle
 */
const maskValue = (value: string | undefined): string => {
    if (!value) return "EMPTY/UNDEFINED";
    if (value.length <= 15) return value;
    return `${value.substring(0, 10)}...${value.substring(value.length - 5)}`;
};

/**
 * Get detailed debugging information
 */
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

/**
 * Build response with optional debug info
 */
const buildDebugResponse = (
    includeDebug: boolean = INCLUDE_DEBUG_INFO,
    verbose: boolean = VERBOSE_DEBUG
) => {
    if (!includeDebug) return undefined;

    const debug = getDebugInfo();

    if (!verbose) {
        // In production, only include essential debug info
        return {
            timestamp: debug.timestamp,
            environment: debug.environment.nodeEnv,
            region: debug.runtime.region,
        };
    }

    // In development, include full debug info
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

    console.log("User Data", userData)

    const fcmToken = userData?.fcm_token;

    if (!fcmToken) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            "User FCM token is not available. User may not have app installed."
        );
    }

    return fcmToken;
};

const sendNotificationToTopic = async (
    title: string,
    body: string,
    customData: Record<string, string>,
    topic: string
): Promise<string> => {
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
    return messageId;
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

// Internal function - used by other endpoints
const sendNotificationToUserInternal = async (
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
    const messageId = await admin.messaging().send(message);
    return messageId;
};

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

            // API Key validation with detailed debugging
            const validApiKey = config.notification.apiKey;
            const authHeader = req.headers.authorization as string;
            const providedApiKey = authHeader?.replace("Bearer ", "");

            // Log detailed validation info
            logger.info("🔐 API Key Validation Started");
            logger.info(`   Auth Header Present: ${!!authHeader}`);
            logger.info(`   Auth Header Length: ${authHeader?.length || 0}`);
            logger.info(`   Auth Header (masked): ${maskValue(authHeader)}`);
            logger.info(`   Provided Key Present: ${!!providedApiKey}`);
            logger.info(`   Provided Key Length: ${providedApiKey?.length || 0}`);
            logger.info(`   Provided Key (masked): ${maskValue(providedApiKey)}`);
            logger.info(`   Valid Key Present: ${!!validApiKey}`);
            logger.info(`   Valid Key Length: ${validApiKey?.length || 0}`);
            logger.info(`   Valid Key (masked): ${maskValue(validApiKey)}`);
            logger.info(`   Keys Match: ${providedApiKey === validApiKey}`);

            if (!providedApiKey || providedApiKey !== validApiKey) {
                logger.warn("❌ Unauthorized API request - Key mismatch");

                const debugInfo = getDebugInfo();
                const executionTime = Date.now() - startTime;

                const response = {
                    success: false,
                    error: "Unauthorized",
                    timestamp: getTimestamp(),
                    ...(INCLUDE_DEBUG_INFO && {
                        debug: {
                            functionName: "sendNotification",
                            executionTime,
                            message: "API key validation failed",
                            authHeaderPresent: !!authHeader,
                            authHeaderLength: authHeader?.length || 0,
                            providedKeyLength: providedApiKey?.length || 0,
                            providedKeyMasked: maskValue(providedApiKey),
                            validKeyLength: validApiKey?.length || 0,
                            validKeyMasked: maskValue(validApiKey),
                            keysMatch: providedApiKey === validApiKey,
                            ...(VERBOSE_DEBUG && {
                                config: debugInfo.config,
                                environment: debugInfo.environment,
                                runtime: debugInfo.runtime,
                            }),
                        },
                    }),
                };

                res.status(401).json(response);
                return;
            }

            logger.info("✅ API Key validation successful");

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