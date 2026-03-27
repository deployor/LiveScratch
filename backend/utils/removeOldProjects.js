/// for some reason this causes a ton of issues :/

import { livescratchPath, scratchprojectsPath } from './fileStorage.js';
import { getCollection } from './db.js';
import cron from 'node-cron';

function sleep(millis) {
    return new Promise(res => setTimeout(res, millis));
}

let inprog=false;
export function installCleaningJob(sessionManager, userManager) {
    // removeOldProjectsAsync(sessionManager, userManager);
    // removeUntetheredScratchprojects(sessionManager,userManager)
    cron.schedule(CRON_EXPRESSION, async () => {
        if(inprog) {return;} // dont do it twice
        inprog=true;
        await removeOldProjectsAsync(sessionManager, userManager);
        await removeUntetheredScratchprojects(sessionManager,userManager);
        inprog=false;
    },{
        scheduled: true,
        timezone: 'Asia/Qatar',
    });
}

const HOW_OLD_DAYS = 60; // delete projects with no new edits in the last this number of days
const CRON_EXPRESSION = '0 2 * * *'; // every night at 2am

async function removeOldProjectsAsync(sessionManager, userManager) {
    const col = getCollection(livescratchPath);
    const docs = await col.find({}, { projection: { _id: 1 } }).toArray();
    const ids = docs.map(d => d._id);
    console.log('removal test started', ids);
    for (let id of ids) {
        await sleep(55); // rate limit might fix issues??????? IM LOSSTTTTTTTT!!!
        try {

            console.log('probing project with id ' + id);
            let project = await sessionManager.getProject(id);
            if (!project) {
                console.log('project doesnt exist, DELETING id ' + id);
                await sessionManager.deleteProjectFile(id); // WARNING- WILL DELETE ALL PROJECTS IF TOO MANY FILES ARE OPEN. CONSIDER REMOVING THIS LINE IN THE FUTURE WHEN LIVESCRATCH HAS TOO MANY FOLKS
            } //todo check if project not existing messes up delete function
            else { // if project does exist
                id = project.id; // since we know that project.id exists

                if (Object.keys(project.session.connectedClients).length == 0) {
                    if (project.project.lastTime && Date.now() - new Date(project.project.lastTime) > HOW_OLD_DAYS * 24 * 60 * 60 * 1000) {

                        console.log(`deleting project ${id} because it is old`);

                        for (const username of [project.owner, ...project.sharedWith]) {
                            await userManager.unShare(username, id);
                            await sessionManager.unshareProject(id, username);
                        }

                        await sessionManager.deleteProjectFile(id);
                    } else {
                        project.trimChanges();
                        await sessionManager.offloadProject(id);
                    }
                }
            }
        }
        catch (e) {
            console.error(`error while probing project ${id}:`, e);
        }
    }
}


async function removeUntetheredScratchprojects(sessionManager, userManager) {
    const col = getCollection(scratchprojectsPath);
    const docs = await col.find({}, { projection: { _id: 1 } }).toArray();
    const scratchids = docs.map(d => d._id);
    console.log('removal scratchprojectsentries test started', scratchids);
    for (let scratchid of scratchids) {

        await sleep(60);
        let entry = await sessionManager.getScratchProjectEntry(scratchid);
        if(!entry) {
            await sessionManager.deleteScratchProjectEntry(scratchid);
            continue;
        }
        let id = entry.blId;
        let project = await sessionManager.getProject(id);
        if (!project) {
            await sessionManager.deleteScratchProjectEntry(scratchid);
            continue;
        }
    }
}