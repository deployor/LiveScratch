import clone from 'clone';

import { isFinalSaving } from '../index.js';
import { getCollection } from './db.js';

// Collection name constants (used by sessionManager, userManager, etc.)
export const livescratchPath = 'projects';
export const scratchprojectsPath = 'scratchprojects';
export const lastIdPath = 'config';
export const usersPath = 'users';
export const bannedPath = 'banned';
export const freePassesPath = 'config';

function sleep(millis) {
    return new Promise(res=>setTimeout(res,millis));
}

const removeChangesStringLength = 514280;
const maxStringWriteLength = 51428000; //absolute max, hopefully never reached

/** Upsert each key→value pair in obj as a MongoDB document {_id: key, data: value}. */
export async function saveMapToFolder(obj, collectionName) {
    if (!obj) { console.error('tried to save null object to collection: ' + collectionName); return; }
    const col = getCollection(collectionName);
    for (const [rawKey, rawValue] of Object.entries(obj)) {
        const key = String(rawKey);
        if (!key) { continue; }
        let data = rawValue;
        let stringg = JSON.stringify(data);
        if (stringg.length >= removeChangesStringLength && data?.project?.changes) {
            data = clone(data, true, 2);
            data.project.changes = [];
            stringg = JSON.stringify(data);
        }
        if (stringg.length > maxStringWriteLength) {
            console.error(`skipping writing "${key}" because its too long`);
            continue;
        }
        try {
            await col.updateOne({ _id: key }, { $set: { _id: key, data } }, { upsert: true });
        } catch (e) {
            console.error('Error when saving document key: ' + key);
            console.error(e);
        }
    }
}

export async function saveMapToFolderAsync(obj, collectionName, failsafeEh, dontRemoveChanges) {
    if (!obj) { console.warn('tried to save null object to collection: ' + collectionName); return; }
    const col = getCollection(collectionName);
    for (const [rawKey, rawValue] of Object.entries(obj)) {
        const key = String(rawKey);
        if (!key) { continue; }
        let data = rawValue;
        let stringg = JSON.stringify(data);
        if (stringg.length >= removeChangesStringLength && data?.project?.changes && !dontRemoveChanges) {
            console.log(`removing changes to save length on projectId: ${key}`);
            data = clone(data, true, 2);
            data.project.changes = [];
            stringg = JSON.stringify(data);
        }
        if (failsafeEh && data?.project?.changes) {
            data = clone(data, false, 2);
            data.project.changes = [];
            stringg = JSON.stringify(data);
        }
        if (stringg.length >= maxStringWriteLength) {
            console.error(`skipping writing project ${key} because its too long`);
            continue;
        }
        try {
            await col.updateOne({ _id: key }, { $set: { _id: key, data } }, { upsert: true });
        } catch (e) { console.error('Error when saving document:'); console.error(e); }
    }
}

/** Load all documents from a collection and return as { id: data } map. */
export async function loadMapFromFolder(collectionName) {
    const col = getCollection(collectionName);
    const docs = await col.find({}).toArray();
    const obj = {};
    for (const doc of docs) {
        obj[doc._id] = doc.data;
    }
    return obj;
}

/** Config helpers – store scalar values in the 'config' collection. */
export async function saveConfig(key, value) {
    const col = getCollection('config');
    await col.updateOne({ _id: key }, { $set: { _id: key, value } }, { upsert: true });
}
export async function loadConfig(key, defaultValue) {
    const col = getCollection('config');
    const doc = await col.findOne({ _id: key });
    return doc !== null ? doc.value : defaultValue;
}

async function saveAsync(sessionManager, saveFreePasses, saveRecent) {
    if (isFinalSaving) { return; } // dont final save twice
    await sleep(10); // in case there is an error that nans lastid out
    await saveConfig('lastId', sessionManager.lastId);
    if (saveFreePasses) { await saveFreePasses(); }
    // DONT SAVE LIVESCRATCH PROJECTS BECAUSE ITS TOO COMPUTATIONALLY EXPENSIVE AND IT HAPPENS ANYWAYS ON OFFLOAD
    if (saveRecent) { await saveRecent(); }
}
export async function saveLoop(sessionManager, saveFreePasses, saveRecent) {
    while (true) {
        try { await saveAsync(sessionManager, saveFreePasses, saveRecent); }
        catch (e) { console.error(e); }
        await sleep(30 * 1000);
    }
}

export async function ban(username) {
    const col = getCollection('banned');
    await col.updateOne({ _id: 'list' }, { $addToSet: { users: username } }, { upsert: true });
}

export async function unban(username) {
    const col = getCollection('banned');
    await col.updateOne({ _id: 'list' }, { $pull: { users: username } });
}

export async function getBanned() {
    const col = getCollection('banned');
    const doc = await col.findOne({ _id: 'list' });
    return doc?.users ?? [];
}