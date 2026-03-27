import { MongoClient } from 'mongodb';

let client;
let db;

export async function connectDB() {
    const uri = process.env.MONGODB_URI;
    if (!uri) { throw new Error('MONGODB_URI environment variable is required'); }
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(); // use the database specified in the URI
    console.log('✅ Connected to MongoDB');
}

export function getCollection(name) {
    if (!db) { throw new Error('MongoDB not connected. Call connectDB() first.'); }
    return db.collection(name);
}
