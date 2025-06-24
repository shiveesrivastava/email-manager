require('dotenv').config();
const express = require('express');
const { connectToDatabase } = require('./db');
const { google } = require('googleapis');

const app = express();
const port = 3000;

// Google OAuth2 Client Setup
const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URL
);

const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];

let db; // Declare a global variable for the database

connectToDatabase().then(database => {
    db = database;
    console.log("Database connected successfully.");
}).catch(error => {
    console.error("Error connecting to database:", error);
    process.exit(1); // Exit the app if the database fails to connect
});

// Route: Generate Google Auth URL
app.get('/', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
    });
    res.send(`<a href="${url}">Auth with Google</a>`);
});

// Route: Handle Google Callback
app.get('/google-callback', async (req, res) => {
    try {
        const { code } = req.query;
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        console.log('Tokens acquired:', tokens);

        // Fetch and store labels
        const labels = await fetchLabels(oauth2Client);
        const labelsCollection = db.collection('labels');
        await labelsCollection.deleteMany(); // Clear existing labels
        await labelsCollection.insertMany(labels.map(label => ({ id: label.id, name: label.name })));

        // Fetch emails
        const newEmailsCount = await readEmails(oauth2Client);

        // Respond with buttons for navigation
        res.send(`
            <h1>Emails fetched and stored successfully!</h1>
            <p>${newEmailsCount} new email(s) added to the database.</p>
            <a href="/fetch-labels" style="padding: 10px; background-color: #007BFF; color: white; text-decoration: none; border-radius: 5px;">Fetch Labels</a>
            <a href="/emails" style="padding: 10px; background-color: #28A745; color: white; text-decoration: none; border-radius: 5px;">View Emails</a>
        `);
    } catch (error) {
        console.error('Error during Google callback:', error);
        res.status(500).send('An error occurred during Google callback. Please try again.');
    }
});

// Route: Display Emails
// Route: Fetch emails based on query parameters (date, sender, etc.)
// Route: Serve the HTML interface for emails
app.get('/emails', async (req, res) => {
    try {
        const bambooboxLabelId = 'Label_1682749667683246852'; // Replace with your actual "Bamboobox" label ID
        const allowedSubcategories = ['SENT', 'INBOX', 'IMPORTANT', 'STARRED', 'CATEGORY_PERSONAL', 'UNREAD'];

        // Fetch emails from MongoDB with only the "Bamboobox" label
        const emails = await db
            .collection('emails')
            .find({ labels: bambooboxLabelId })
            .toArray();

        // Fetch labels from MongoDB for categorization
        const labels = await db.collection('labels').find().toArray();

        // Filter and rename allowed labels for categorization
        const filteredLabels = labels
            .filter((label) => allowedSubcategories.includes(label.id))
            .map((label) => ({
                ...label,
                name: label.id === 'CATEGORY_PERSONAL' ? 'PERSONAL' : label.name,
            }));

        // Categorize emails based on their subcategories
        const categorizedEmails = {};
        filteredLabels.forEach((label) => {
            categorizedEmails[label.name] = emails.filter((email) => email.labels.includes(label.id));
        });

        // Render HTML to display categorized emails
        res.send(`
            <html>
                <head>
                    <title>Bamboobox Emails</title>
                </head>
                <body>
                    <h1>Bamboobox Emails</h1>
                    <button onclick="syncEmails()">Sync Now</button>
                    <script>
                        async function syncEmails() {
                            const response = await fetch('/sync-emails');
                            const result = await response.json();
                            if (result.success) {
                                alert(result.message);
                                location.reload(); // Reload page to display updated emails
                            } else {
                                alert(result.message);
                            }
                        }
                    </script>
                    ${Object.entries(categorizedEmails)
                        .map(
                            ([category, emails]) => `
                            <h2>${category}</h2>
                            <ul>
                                ${emails
                                    .map(
                                        (email) => `
                                    <li>
                                        <strong>From:</strong> ${email.from}<br>
                                        <strong>Subject:</strong> ${email.subject}<br>
                                        <strong>Timestamp:</strong> ${email.timestamp}
                                    </li>
                                `
                                    )
                                    .join('') || `<li>No emails in this category.</li>`}
                            </ul>
                        `
                        )
                        .join('') || `<p>No emails found under the "Bamboobox" label.</p>`}
                </body>
            </html>
        `);
    } catch (error) {
        console.error('Error displaying emails by labels:', error);
        res.status(500).send('An error occurred.');
    }
});

app.get('/fetch-labels', async (req, res) => {
    try {
        if (!oauth2Client.credentials) {
            return res.status(400).send('OAuth2 client is not authenticated. Please authenticate first.');
        }

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const response = await gmail.users.labels.list({ userId: 'me' });
        res.json(response.data.labels);
    } catch (error) {
        console.error('Error fetching labels:', error);
        res.status(500).send('Error fetching labels');
    }
});

// Route: Sync Emails Manually
app.get('/sync-emails', async (req, res) => {
    try {
        const newEmailsCount = await readEmails(oauth2Client); // Sync emails
        res.json({ success: true, message: `${newEmailsCount} new emails synced.` });
    } catch (error) {
        console.error('Error during manual sync:', error);
        res.status(500).json({ success: false, message: 'An error occurred during sync.' });
    }
});

// Function: Get Individual Email Details
async function getEmailDetails(emailId, gmail) {
    const response = await gmail.users.messages.get({ userId: 'me', id: emailId });
    const email = response.data;

    // Extract necessary details
    const subject = email.payload.headers.find((header) => header.name === 'Subject')?.value || '(No Subject)';
    const fromRaw = email.payload.headers.find((header) => header.name === 'From')?.value || '(Unknown Sender)';
    const from = fromRaw.match(/([^<]*)</)?.[1]?.trim() || fromRaw; // Extract sender's name
    const timestamp = new Date(parseInt(email.internalDate)).toLocaleString();

    // Extract labels
    const labels = email.labelIds || [];

    return {
        emailId,
        subject,
        from,
        snippet: email.snippet || '',
        timestamp,
        labels,
    };
}

// Function: Fetch and Display Emails
async function readEmails(auth) {
    const gmail = google.gmail({ version: 'v1', auth });
    const emailsCollection = db.collection('emails');
    const labelId = 'Label_1682749667683246852'; // Replace with your actual 'Bamboobox' label ID

    // Fetch emails from Gmail with the 'Bamboobox' label
    const response = await gmail.users.messages.list({
        userId: 'me',
        labelIds: [labelId],
        maxResults: 100, // Adjust as needed
    });

    const gmailEmails = response.data.messages || [];
    const gmailEmailIds = gmailEmails.map((email) => email.id);

    // Fetch emails from MongoDB with the 'Bamboobox' label
    const dbEmails = await emailsCollection.find({ labels: labelId }).toArray();
    const dbEmailIds = dbEmails.map((email) => email.emailId);

    // Delete emails from MongoDB that are no longer in Gmail
    const emailsToDelete = dbEmails.filter((email) => !gmailEmailIds.includes(email.emailId));
    if (emailsToDelete.length > 0) {
        await emailsCollection.deleteMany({ emailId: { $in: emailsToDelete.map((email) => email.emailId) } });
        console.log(`Deleted ${emailsToDelete.length} outdated email(s) from MongoDB.`);
    }

    // Add or update emails in MongoDB
    let newEmailsCount = 0;
    for (const gmailEmail of gmailEmails) {
        const emailDetails = await fetchEmailDetails(gmailEmail.id, gmail); // Fetch full details
        await emailsCollection.updateOne(
            { emailId: emailDetails.emailId }, // Filter by email ID
            { $set: emailDetails }, // Update email details, including updated labels
            { upsert: true } // Insert if not exists
        );
        if (!dbEmailIds.includes(emailDetails.emailId)) {
            newEmailsCount++;
        }
    }

    console.log(`New emails added: ${newEmailsCount}`);
    return newEmailsCount;
}

async function fetchAndStoreEmails(auth) {
    const gmail = google.gmail({ version: 'v1', auth });
    const emailsCollection = db.collection('emails'); // Ensure `db` is your MongoDB connection

    try {
        // Fetch a list of email message IDs
        const response = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 30, // Fetch the 30 latest emails
        });

        const messages = response.data.messages;
        if (!messages || messages.length === 0) {
            console.log("No messages found.");
            return;
        }

        // Fetch details of each email and store them in MongoDB
        await Promise.all(messages.map(async (message) => {
            const emailData = await fetchEmailDetails(message.id, gmail);
            await emailsCollection.updateOne(
                { emailId: emailData.emailId }, // Unique identifier for emails
                { $set: emailData },
                { upsert: true } // Insert if not exists
            );
        }));

        console.log("Emails fetched and stored successfully!");
    } catch (error) {
        console.error("Error fetching or storing emails:", error);
    }
}

async function fetchEmailDetails(emailId, gmail) {
    const response = await gmail.users.messages.get({
        userId: 'me',
        id: emailId,
    });

    const email = response.data;

    // Extract useful details from the email
    const subject = email.payload.headers.find((h) => h.name === 'Subject')?.value || '(No Subject)';
    const fromRaw = email.payload.headers.find((h) => h.name === 'From')?.value || '(Unknown Sender)';
    const from = fromRaw.match(/([^<]*)</)?.[1]?.trim() || fromRaw; // Extract sender's name
    const timestamp = new Date(parseInt(email.internalDate)).toLocaleString();

    // Extract labels
    const labels = email.labelIds || []; // Gmail API's labelIds field

    return {
        emailId,
        subject,
        from,
        snippet: email.snippet || '',
        timestamp,
        labels, // Add labels to the returned object
    };
}

async function fetchLabels(auth) {
    const gmail = google.gmail({ version: 'v1', auth });
    try {
        const response = await gmail.users.labels.list({
            userId: 'me',
        });

        const labels = response.data.labels || [];
        console.log("Fetched Labels:", labels);
        return labels;
    } catch (error) {
        console.error("Error fetching labels:", error);
        return [];
    }
}


// Start the Server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});