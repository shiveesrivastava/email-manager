const { MongoClient } = require('mongodb');

// MongoDB Connection URI
const uri = "mongodb://localhost:27017"; // Change this if needed
const client = new MongoClient(uri);

let db;

// Connect to MongoDB
async function connectToDatabase() {
    try {
        if (!db) {
            await client.connect();
            console.log("Connected to MongoDB!");
            db = client.db("gmailManager"); // Use your desired database name
        }
        return db;
    } catch (error) {
        console.error("Error connecting to MongoDB:", error);
        process.exit(1);
    }
}

// Close MongoDB connection
async function closeConnection() {
    try {
        await client.close();
        console.log("MongoDB connection closed.");
    } catch (error) {
        console.error("Error closing MongoDB connection:", error);
    }
}

module.exports = { connectToDatabase, closeConnection };
