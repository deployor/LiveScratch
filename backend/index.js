import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const backendDir = dirname(fileURLToPath(import.meta.url));
// Load backend-local .env first (takes priority), then fill missing vars from repo-root .env
dotenv.config({ path: resolve(backendDir, '.env'), quiet: true });
dotenv.config({ path: resolve(backendDir, '../.env'), quiet: true });

// be mindful of:
// numbers being passed as strings

///////////
import express from 'express';
const app = express();
import cors from 'cors';
app.use(cors({origin:'*'}));
app.use(express.json({ limit: '5MB' }));
import basicAuth from 'express-basic-auth';
import http from 'http';

let httpServer = http.createServer(app);

import {Server} from 'socket.io';
const ioHttp = new Server(httpServer, {
    cors:{origin:'*'},
    maxHttpBufferSize:2e7,
});

import SessionManager from './utils/sessionManager.js';
import UserManager from './utils/userManager.js';
import sanitize from 'sanitize-filename';

export let isFinalSaving = false;

import { connectDB } from './utils/db.js';
import * as fileStorageUtils from './utils/fileStorage.js';
import { installCleaningJob } from './utils/removeOldProjects.js';
import { countRecentShared, recordPopup, loadRecent, saveRecent } from './utils/recentUsers.js';
import { setPaths, fullAuthenticate, authenticate, freePasses, loadFreePasses, saveFreePasses } from './utils/scratch-auth.js';
import initSockets from './WebSockets.js';

const restartMessage = 'The Livescratch server is restarting. You will lose connection for a few seconds.';

function sleep(millis) {
    return new Promise(res=>setTimeout(res,millis));
}

var sessionManager;
var userManager;

async function finalSave(sm) {
    try{
        if(isFinalSaving) {return;} // Exit early if another save is in progress to avoid duplication
        console.log('sending message "' + restartMessage + '"');
        sm.broadcastMessageToAllActiveProjects(restartMessage);
        await sleep(1000 * 2);
        isFinalSaving = true;
        console.log('final saving...');
        await fileStorageUtils.saveConfig('lastId', sm.lastId);
        await saveFreePasses();
        await sm.finalSaveAllProjectsAsync(); // Save all active project data to MongoDB.
        await fileStorageUtils.saveMapToFolder(userManager.users, fileStorageUtils.usersPath);
        await saveRecent();
        process.exit();
    } catch (e) {
        await sleep(1000 * 10); // If an error occurs, wait 10 seconds before allowing another save attempt
        isFinalSaving = false;
    }
}

// ─── Async startup ────────────────────────────────────────────────────────────
(async () => {
    // 1. Connect to MongoDB
    await connectDB();

    // 2. Load persisted state from MongoDB
    await loadFreePasses();
    await loadRecent();
    const storedLastId = await fileStorageUtils.loadConfig('lastId', 0);

    // 3. Build manager instances
    sessionManager = new SessionManager();
    sessionManager.lastId = Number(storedLastId) || 0;

    userManager = new UserManager();
    setPaths(app, userManager, sessionManager);

    fileStorageUtils.saveLoop(sessionManager, saveFreePasses, saveRecent);

    setTimeout(()=>installCleaningJob(sessionManager,userManager),1000 * 10);

    new initSockets(ioHttp, sessionManager, userManager);

    // ─── HTTP routes ──────────────────────────────────────────────────────────
    // todo: save info & credits here
    app.post('/newProject/:scratchId/:owner', async (req,res)=>{
        if(!await authenticate(req.params.owner,req.headers.authorization)) {res.send({noauth:true}); return;}
        if( !req.params.scratchId || ( sanitize(req.params.scratchId.toString()) == '' ) ) {res.send({err:'invalid scratch id'}); return;}
        let project = await sessionManager.getScratchToLSProject(req.params.scratchId);
        let json = req.body;
        if(!project) {
            console.log('creating new project from scratch project: ' + req.params.scratchId + ' by ' + req.params.owner + ' titled: ' + req.query.title);
            project = await sessionManager.newProject(req.params.owner,req.params.scratchId,json,req.query.title);
            await userManager.newProject(req.params.owner,project.id);
        }
        res.send({id:project.id});
    });

    app.get('/lsId/:scratchId/:uname', async (req,res)=>{
        let lsId = (await sessionManager.getScratchProjectEntry(req.params.scratchId))?.blId;
        if(!lsId) {res.send(lsId); return;}
        let project = await sessionManager.getProject(lsId);
        if(!project) { // if the project doesnt exist, dont send it!!!
            await sessionManager.deleteScratchProjectEntry(req.params.scratchId);
            res.send(null);
            return;
        }
        let hasAccess = await fullAuthenticate(req.params.uname,req.headers.authorization,lsId);
        // let hasAccess = project.isSharedWithCaseless(req.params.uname)

        res.send(hasAccess ? lsId : null);
    });
    app.get('/scratchIdInfo/:scratchId', async (req,res)=>{
        if (await sessionManager.doesScratchProjectEntryExist(req.params.scratchId)) {
            res.send(await sessionManager.getScratchProjectEntry(req.params.scratchId));
        } else {
            res.send({err:('could not find livescratch project associated with scratch project id: ' + req.params.scratchId)});
        }
    });
    // meechapooch: "todo: sync info and credits with this endpoint as well?" Waakul: Na hail naw, setting idea unlocked!
    app.get('/projectTitle/:id', async (req,res)=>{
        if(!await fullAuthenticate(req.headers.uname,req.headers.authorization,req.params.id)) {res.send({noauth:true}); return;}

        let project = await sessionManager.getProject(req.params.id);
        if(!project) {
            res.send({err:'could not find project with livescratch id: ' + req.params.id});
        } else {
            res.send({title:project.project.title});
        }
    });
    app.post('/projectSavedJSON/:lsId/:version', async (req,res)=>{
        if(!await fullAuthenticate(req.headers.uname,req.headers.authorization,req.params.lsId)) {res.send({noauth:true}); return;}

        let json = req.body;
        let project = await sessionManager.getProject(req.params.lsId);
        if(!project) {
            console.log('Could not find project: '+req.params.lsId);
            res.send({ err: 'Couldn\'t find the specified project!' });
            return;
        }
        project.scratchSavedJSON(json,parseFloat(req.params.version));
        res.send({ success: 'Successfully saved the project!' });
    });
    app.get('/projectJSON/:lsId', async (req,res)=>{
        if(!await fullAuthenticate(req.query.username,req.headers.authorization,req.params.lsId)) {res.send({noauth:true}); return;}

        let lsId = req.params.lsId;
        let project = await sessionManager.getProject(lsId);
        if(!project) {res.sendStatus(404); return;}
        let json = project.projectJson;
        let version = project.jsonVersion;
        res.send({json,version});
        return;
    });

    app.use('/html',express.static('static'));
    app.get('/changesSince/:id/:version', async (req,res)=>{
        if(!await fullAuthenticate(req.headers.uname,req.headers.authorization,req.params.id)) {res.send({noauth:true}); return;}

        let project = await sessionManager.getProject(req.params.id);
        if(!project) {res.send([]);}
        else {

            let oldestChange = project.project.getIndexZeroVersion();
            let clientVersion = req.params.version;
            let jsonVersion = project.jsonVersion;
            let forceReload = clientVersion<oldestChange-1 && jsonVersion>=oldestChange-1;
            if(clientVersion<oldestChange-1 && jsonVersion<oldestChange-1) {console.error('client version too old AND json version too old. id,jsonVersion,clientVersion,indexZeroVersion',project.id,jsonVersion,clientVersion,oldestChange);}

            let changes = project.project.getChangesSinceVersion(parseFloat(req.params.version));
            if(forceReload) {
                changes=ListToObj(changes);
                changes.forceReload=true;
            }

            res.send(changes);
        }
    });
    function ListToObj(list) {
        let output={length:list.length};
        for(let i=0; i<list.length; i++) {
            output[i]=list[i];
        }
        return output;
    }

    app.get('/chat/:id', async (req,res)=>{
        if(!await fullAuthenticate(req.headers.uname,req.headers.authorization,req.params.id)) {res.send({noauth:true}); return;}
        let project = await sessionManager.getProject(req.params.id);
        if(!project) {res.send([]);}
        else {
            res.send(project.getChat());
        }
    });

    app.use('/ban', basicAuth({
        users: JSON.parse(process.env.ADMIN_USER),
        challenge: true,
    }));
    app.put('/ban/:username', (req,res) => {
        fileStorageUtils.ban(req.params.username)
            .then(() => {
                res.send({ success: 'Successfully banned!' });
            })
            .catch((err) => {
                res.send({ err: err });
            });
    });

    app.use('/unban', basicAuth({
        users: JSON.parse(process.env.ADMIN_USER),
        challenge: true,
    }));
    app.put('/unban/:username', (req,res) => {
        fileStorageUtils.unban(req.params.username)
            .then(() => {
                res.send({ success: 'Successfully unbanned!' });
            })
            .catch((err) => {
                res.send({ err: err });
            });
    });

    app.use('/banned', basicAuth({
        users: JSON.parse(process.env.ADMIN_USER),
        challenge: true,
    }));
    app.get('/banned', (req,res) => {
        fileStorageUtils.getBanned()
            .then((bannedList) => {
                res.send(bannedList);
            })
            .catch((err) => {
                res.send({ err: err });
            });
    });

    let cachedStats = null;
    let cachedStatsTime = 0;
    let cachedStatsLifetimeMillis = 1000;
    app.use('/stats',basicAuth({
        users: JSON.parse(process.env.ADMIN_USER),
        challenge: true,
    }));
    app.get('/stats', async (req,res)=>{
        if(Date.now() - cachedStatsTime > cachedStatsLifetimeMillis) {
            cachedStats = await sessionManager.getStats();
            cachedStats.cachedAt = new Date();
            cachedStatsTime = Date.now();
        }
        res.send(cachedStats);
    });

    app.get('/dau/:days',(req,res)=>{
        res.send(String(countRecentShared(parseFloat(req.params.days))));
    });
    app.put('/linkScratch/:scratchId/:lsId/:owner', async (req,res)=>{
        if(!await fullAuthenticate(req.params.owner,req.headers.authorization,req.params.lsId)) {res.send({noauth:true}); return;}

        console.log('linking:',req.params);
        await sessionManager.linkProject(req.params.lsId,req.params.scratchId,req.params.owner,0);
        res.send({ success: 'Successfully linked!' });
    });
    app.get('/userExists/:username', async (req,res)=>{
        res.send(await userManager.userExists(req.params.username) && !(await userManager.getUser(req.params.username)).privateMe);
    });
    app.put('/privateMe/:username/:private', async (req,res)=>{
        req.params.username = sanitize(req.params.username);
        if(!await authenticate(req.params.username,req.headers.authorization)) {res.send({noauth:true}); return;}
        let user = await userManager.getUser(req.params.username);
        user.privateMe = req.params.private == 'true';
        res.status(200).end();
    });
    app.get('/privateMe/:username', async (req,res)=>{
        req.params.username = sanitize(req.params.username);
        if(!await authenticate(req.params.username,req.headers.authorization)) {res.send({noauth:true}); return;}
        let user = await userManager.getUser(req.params.username);
        res.send(user.privateMe);
    });
    app.get('/userRedirect/:scratchId/:username', async (req,res)=>{

        let project = await sessionManager.getScratchToLSProject(req.params.scratchId);

        if(!await fullAuthenticate(req.params.username,req.headers.authorization,project?.id)) {res.send({noauth:true,goto:'none'}); return;}

        if(!project) {res.send({goto:'none'}); return;}

        let ownedProject = project.getOwnersProject(req.params.username);
        if(!!ownedProject) {
            res.send({goto:ownedProject.scratchId});
        } else {
            res.send({goto:'new', lsId:project.id});
        }
    });

    app.get('/active/:lsId', async (req,res)=>{
        if(!await fullAuthenticate(req.headers.uname,req.headers.authorization,req.params.lsId)) {res.send({noauth:true}); return;}

        let usernames = (await sessionManager.getProject(req.params.lsId))?.session.getConnectedUsernames();
        let clients = (await sessionManager.getProject(req.params.lsId))?.session.getConnectedUsersClients();
        if(usernames) {
            res.send(await Promise.all(usernames.map(async name=>{
                let user = await userManager.getUser(name);
                return {username:user.username,pk:user.pk,cursor:clients[name].cursor};
            })));
        } else {
            res.send({err:'could not get users for project with id: ' + req.params.lsId});
        }
    });

    app.get('/',(req,res)=>{
        res.send('LiveScratch API');
    });

    app.post('/friends/:user/:friend', async (req,res)=>{
        if(!await authenticate(req.params.user,req.headers.authorization)) {res.send({noauth:true}); return;}

        if (!await userManager.userExists(req.params.friend)) {
            res.sendStatus(404);
            return;
        }

        await userManager.befriend(req.params.user,req.params.friend);
        res.send({ success: 'Successfully friended!' });
    });
    app.delete('/friends/:user/:friend', async (req,res)=>{
        if(!await authenticate(req.params.user,req.headers.authorization)) {res.send({noauth:true}); return;}

        await userManager.unbefriend(req.params.user,req.params.friend);
        res.send({ success: 'Succesfully unfriended!' });

    });
    app.get('/friends/:user', async (req,res)=>{
        recordPopup(req.params.user);
        if(!await authenticate(req.params.user,req.headers.authorization)) {res.send({noauth:true}); return;}

        res.send((await userManager.getUser(req.params.user))?.friends);
    });

    // get list of livescratch id's shared TO user (from another user)
    app.get('/userProjects/:user', async (req,res)=>{
        if(!await authenticate(req.params.user,req.headers.authorization)) {res.send({noauth:true}); return;}

        res.send(await userManager.getShared(req.params.user));
    });
    // get list of scratch project info shared with user for displaying in mystuff
    app.get('/userProjectsScratch/:user', async (req,res)=>{
        if(!await authenticate(req.params.user,req.headers.authorization)) {res.send({noauth:true}); return;}

        let livescratchIds = await userManager.getAllProjects(req.params.user);
        let projectsList = (await Promise.all(livescratchIds.map(async id=>{
            let projectObj = {};
            let project = await sessionManager.getProject(id);
            if(!project) {return null;}
            projectObj.scratchId = project.getOwnersProject(req.params.user)?.scratchId;
            if(!projectObj.scratchId) {projectObj.scratchId = project.scratchId;}
            projectObj.blId = project.id;
            projectObj.title = project.project.title;
            projectObj.lastTime = project.project.lastTime;
            projectObj.lastUser = project.project.lastUser;
            projectObj.online = project.session.getConnectedUsernames();

            return projectObj;
        }))).filter(Boolean); // filter out non-existant projects // TODO: automatically delete dead pointers like this
        res.send(projectsList);
    });

    app.put('/leaveScratchId/:scratchId/:username', async (req,res)=>{
        let project = await sessionManager.getScratchToLSProject(req.params.scratchId);

        if(!await fullAuthenticate(req.params.username, req.headers.authorization, project, false)) {res.send({noauth:true}); return;}
        await userManager.unShare(req.params.username, project.id);
        await sessionManager.unshareProject(project.id, req.params.username);
        res.send({ success: 'User succesfully removed!'});
    });
    app.put('/leaveLSId/:lsId/:username', async (req,res)=>{
        if(!await authenticate(req.params.username,req.headers.authorization)) {res.send({noauth:true}); return;}
        await userManager.unShare(req.params.username, req.params.lsId);
        await sessionManager.unshareProject(req.params.lsId, req.params.username);
        res.send({ success: 'User succesfully removed!'});
    });
    app.get('/verify/test', async (req,res)=>{
        res.send({verified: await authenticate(req.query.username,req.headers.authorization)});
    });


    app.get('/share/:id', async (req,res)=>{
        if(!await fullAuthenticate(req.headers.uname,req.headers.authorization,req.params.id)) {res.send({noauth:true}); return;} // todo fix in extension

        let project = await sessionManager.getProject(req.params.id);
        let list = project?.sharedWith;
        if(!list) {res.send({ err: 'No shared list found for the specified project.' }); return;}
        list = await Promise.all(list.map(async name=>({username:name,pk:(await userManager.getUser(name)).pk}))); // Add user ids for profile pics
        res.send(list ? [{username:project.owner,pk:(await userManager.getUser(project.owner)).pk}].concat(list) : {err:'could not find livescratch project: ' + req.params.id} );
    });
    app.put('/share/:id/:to/:from', async (req,res)=>{
        if(!await fullAuthenticate(req.params.from,req.headers.authorization,req.params.id)) {res.send({noauth:true}); return;}

        if((await sessionManager.getProject(req.params.id))?.owner == req.params.to) {
            res.send({ err: 'Cannot share the project with the owner.' });
            return;
        }

        if (!await userManager.userExists(req.params.to)) {
            res.sendStatus(404);
            return;
        }

        await sessionManager.shareProject(req.params.id, req.params.to, req.query.pk);
        (await userManager.getUser(req.params.to)).pk = req.query.pk;
        await userManager.share(req.params.to, req.params.id, req.params.from);
        res.send({ success: 'Project successfully shared.' });
    });
    app.put('/unshare/:id/:to/', async (req,res)=>{
        if(!await fullAuthenticate(req.headers.uname,req.headers.authorization,req.params.id)) {res.send({noauth:true}); return;}

        if((await sessionManager.getProject(req.params.id))?.owner == req.params.to) {
            res.send({ err: 'Cannot unshare the project with the owner.' });
            return;
        }
        await sessionManager.unshareProject(req.params.id, req.params.to);
        await userManager.unShare(req.params.to, req.params.id);
        res.send({ success: 'Project successfully unshared.' });
    });

    const port = process.env.PORT || 3000;
    httpServer.listen(port, '0.0.0.0', () => {
        const env = process.env.NODE_ENV || 'development';
        const isProd = env === 'production';
        const sessionCount = Object.keys(sessionManager.livescratch || {}).length;
        const runtime = typeof Bun !== 'undefined'
            ? `Bun ${Bun.version}`
            : `Node.js ${process.version}`;
        const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

        // ANSI helpers
        const c = {
            reset:  '\x1b[0m',
            bold:   '\x1b[1m',
            dim:    '\x1b[2m',
            green:  '\x1b[32m',
            cyan:   '\x1b[36m',
            yellow: '\x1b[33m',
            red:    '\x1b[31m',
            blue:   '\x1b[34m',
            white:  '\x1b[97m',
        };

        const envLabel = isProd
            ? `${c.green}${c.bold}production${c.reset}`
            : `${c.yellow}${c.bold}development${c.reset}`;

        const line = (label, value) =>
            `  ${c.dim}│${c.reset}  ${c.bold}${label.padEnd(10)}${c.reset}${c.dim}:${c.reset}  ${value}`;

        console.log('');
        console.log(`  ${c.cyan}${c.bold}🚀 LiveScratch backend started!${c.reset}`);
        console.log(`  ${c.dim}${'─'.repeat(38)}${c.reset}`);
        console.log(line('Port',     `${c.white}${port}${c.reset}`));
        console.log(line('Env',      envLabel));
        console.log(line('Sessions', `${c.white}${sessionCount} loaded${c.reset}`));
        console.log(line('Runtime',  `${c.white}${runtime}${c.reset}`));
        console.log(line('Memory',   `${c.white}${memMB} MB${c.reset}`));
        console.log(line('Started',  `${c.white}${new Date().toISOString()}${c.reset}`));
        console.log(`  ${c.dim}${'─'.repeat(38)}${c.reset}`);
        console.log('');
    });


    // initial handshake:
    // client says hi, sends username & creds, sends project id
    // server generates id, sends id
    // server sends JSON or scratchId
    // client loads, sends when isReady
    // connection success!! commense the chitter chatter!


    // copied from https://stackoverflow.com/questions/14031763/doing-a-cleanup-action-just-before-node-js-exits

    process.stdin.resume();//so the program will not close instantly

    async function exitHandler(options, exitCode) {
        if (options.cleanup) console.log('clean');
        if (exitCode || exitCode === 0) console.log(exitCode);

        if(options.exit) {finalSave(sessionManager);}

    }

    //do something when app is closing
    process.on('exit', exitHandler.bind(null,{cleanup:true}));

    //catches ctrl+c event
    process.on('SIGINT', exitHandler.bind(null, {exit:true}));

    // catches "kill pid" (for example: nodemon restart)
    process.on('SIGUSR1', exitHandler.bind(null, {exit:true}));
    process.on('SIGUSR2', exitHandler.bind(null, {exit:true}));

    //catches uncaught exceptions
    process.on('uncaughtException', exitHandler.bind(null, {exit:true}));

    // catches unhandled promise rejections (async errors that would otherwise be swallowed)
    process.on('unhandledRejection', (reason) => {
        console.error('⚠️  Unhandled promise rejection:', reason);
        exitHandler({ exit: true });
    });

})().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
