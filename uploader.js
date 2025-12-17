const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// CONFIGURATION
const KEY_FILE = path.resolve(__dirname, './api-key.json'); // Force absolute path
const AAB_PATH = path.resolve(__dirname, './app-release.aab'); // Force absolute path
const PACKAGE_NAME = 'com.monlook.app'; // Double check this matches build.gradle
const TRACK = 'alpha';

const SCOPES = ['https://www.googleapis.com/auth/androidpublisher'];

async function uploadBundle() {
    console.log('🚀 Authenticating...');
    
    // 1. Check File Existence
    if (!fs.existsSync(AAB_PATH)) {
        console.error(`❌ File not found at: ${AAB_PATH}`);
        process.exit(1);
    }
    const fileSize = fs.statSync(AAB_PATH).size;
    console.log(`📦 File found: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_FILE,
        scopes: SCOPES,
    });

    const client = await auth.getClient();
    const androidPublisher = google.androidpublisher({
        version: 'v3',
        auth: client,
    });

    try {
        // 2. Create Edit
        console.log('📝 Creating Edit session...');
        const editRes = await androidPublisher.edits.insert({
            packageName: PACKAGE_NAME,
        });
        const editId = editRes.data.id;
        console.log(`✅ Edit ID: ${editId}`);

        // 3. Upload AAB (USING BUFFER method to prevent 500 Errors)
        console.log('📤 Uploading AAB (Buffer mode)...');
        
        // Load file into RAM
        const fileBuffer = fs.readFileSync(AAB_PATH);

        const bundleRes = await androidPublisher.edits.bundles.upload({
            editId: editId,
            packageName: PACKAGE_NAME,
            media: {
                mimeType: 'application/octet-stream',
                body: fileBuffer, // Sending buffer instead of stream
            },
        });
        
        const versionCode = bundleRes.data.versionCode;
        console.log(`✅ Uploaded! Version Code: ${versionCode}`);

        // 4. Assign to Track
        console.log(`🛤️  Assigning to track: ${TRACK}...`);
        await androidPublisher.edits.tracks.update({
            editId: editId,
            packageName: PACKAGE_NAME,
            track: TRACK,
            requestBody: {
                releases: [{
                    name: `Release ${versionCode}`,
                    versionCodes: [versionCode],
                    status: 'completed',
                }],
            },
        });

        // 5. Commit
        console.log('💾 Committing changes...');
        await androidPublisher.edits.commit({
            editId: editId,
            packageName: PACKAGE_NAME,
        });

        console.log('🎉 SUCCESS! Update is live.');

    } catch (error) {
        console.error('❌ Error uploading:', error.message);
        if (error.response) {
            console.error('Details:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

uploadBundle();