import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// ============ Interfaces ============

interface NotificationConfig {
    apiKey: string;
}

interface EmailConfig {
    sendgridApiKey: string;
    fromEmail: string;
}

interface StripeConfig {
    apiKey: string;
}

export interface AppConfig {
    notification: NotificationConfig;
    email: EmailConfig;
    stripe: StripeConfig;
    environment: 'development' | 'production' | 'test';
    isDevelopment: boolean;
    isProduction: boolean;
}

// ============ Configuration ============

const config: AppConfig = {
    notification: {
        apiKey: process.env.NOTIFICATION_API_KEY || '',
    },
    email: {
        sendgridApiKey: process.env.SENDGRID_API_KEY || '',
        fromEmail: process.env.SENDGRID_FROM_EMAIL || '',
    },
    stripe: {
        apiKey: process.env.STRIPE_API_KEY || '',
    },
    environment: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development',
    isDevelopment: process.env.NODE_ENV === 'development',
    isProduction: process.env.NODE_ENV === 'production',
};

// ============ Validation ============

interface ConfigValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}

function validateConfig(): ConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Notification config validation
    if (!config.notification.apiKey) {
        warnings.push('⚠️  NOTIFICATION_API_KEY not configured');
    }

    // Email config validation
    // if (!config.email.sendgridApiKey) {
    //     warnings.push('⚠️  SENDGRID_API_KEY not configured');
    // }
    if (!config.email.fromEmail) {
        warnings.push('⚠️  SENDGRID_FROM_EMAIL not configured');
    }

    // Stripe config validation
    if (!config.stripe.apiKey) {
        warnings.push('⚠️  STRIPE_API_KEY not configured');
    }

    // In production, some configs are required
    if (config.isProduction) {
        if (!config.notification.apiKey) {
            errors.push('❌ NOTIFICATION_API_KEY is required in production');
        }
        if (!config.email.sendgridApiKey) {
            errors.push('❌ SENDGRID_API_KEY is required in production');
        }
        if (!config.email.fromEmail) {
            errors.push('❌ SENDGRID_FROM_EMAIL is required in production');
        }
        if (!config.stripe.apiKey) {
            errors.push('❌ STRIPE_API_KEY is required in production');
        }
    }

    return {
        isValid: errors.length === 0,
        errors,
        warnings,
    };
}

// ============ Initialization ============

const validation = validateConfig();

// Log validation results
if (validation.errors.length > 0) {
    console.error('\n🔴 Configuration Errors:');
    validation.errors.forEach((error) => console.error(`  ${error}`));

    // Throw error in production
    if (config.isProduction) {
        throw new Error('Invalid configuration: Missing required environment variables');
    }
}

if (validation.warnings.length > 0) {
    console.warn('\n⚠️  Configuration Warnings:');
    validation.warnings.forEach((warning) => console.warn(`  ${warning}`));
}

if (validation.isValid && validation.errors.length === 0) {
    console.log('\n✅ Configuration loaded successfully');
}

console.log(`📍 Environment: ${config.environment}\n`);

// ============ Export ============

export default config;

// Export validation function for testing
export { validateConfig };

// require('dotenv').config();
//
// const config = {
//     notification: {
//         apiKey: process.env.NOTIFICATION_API_KEY,
//     },
//     email: {
//         sendgridApiKey: process.env.SENDGRID_API_KEY,
//         fromEmail: process.env.SENDGRID_FROM_EMAIL,
//     },
//     stripe: {
//         apiKey: process.env.STRIPE_API_KEY,
//     }
// };
//
// // Validate required config
// function validateConfig() {
//     if (!config.notification.apiKey) {
//         console.warn('⚠️ NOTIFICATION_API_KEY not configured');
//     }
// }
//
// validateConfig();
//
// module.exports = config;