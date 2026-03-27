import { loadConfig, saveConfig } from './fileStorage.js';
export const failedAuthLog = {};
export const secondTimeSuccessAuthLog = {};
const authProjects = JSON.parse(process.env.AUTH_PROJECTS);
const admin = JSON.parse(process.env.ADMIN);


function logAuth(username, success, word, info) {
    if (!username) { return; }
    if (success) {
        if(word!='authenticate'){console.log(`✅ Successfully ${word}ed user ${username}`);}
        if (username in failedAuthLog) {
            delete failedAuthLog[username];
            secondTimeSuccessAuthLog[username] = true;
        }
    } else {
        failedAuthLog[username] = (failedAuthLog[username] instanceof Array) ? (failedAuthLog[username].length > 10 ? failedAuthLog[username] : [...failedAuthLog[username] ,info]) : [info]; 
        console.error(`🆘 Failed to ${word} user ${username}`);

    }
}

let pendingMap = {}; // publicAuthCode : clientSecret 

function sleep(millis) {
    return new Promise(res => setTimeout(res, millis));
}

async function waitForVerificationCloud(tempCode, maxWaitMillis = 15000, stepMillis = 2500) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < maxWaitMillis) {
        const cloud = await getVerificationCloud(tempCode);

        if (cloud?.code == 'nocon') {
            return cloud;
        }

        if (cloud && !cloud?.err) {
            return cloud;
        }

        await sleep(stepMillis);
    }

    return null;
}


let idIndex = 0;
export function getAuthStats() {
    return { idIndex, info: getAuthProjectId(), failed: Object.keys(failedAuthLog).length, secondTimeSuccessCount:Object.keys(secondTimeSuccessAuthLog).length };
}

function generateAuthCode() {
    return Math.floor(Math.random() * 1000000).toString();
}

function getAuthProjectId() {
    return authProjects[idIndex];
}

let userManager;
let sessionManager;
export function setPaths(app, userManagerr, sessionManagerr) {
    userManager = userManagerr;
    sessionManager = sessionManagerr;
    app.get('/verify/start', (req, res) => { // ?code=000000
        let debugUname = req.headers.uname;
        console.log(`starting to authenticate user ${debugUname}`);

        let clientCode = req.query.code;
        let verifyCode = generateAuthCode();

        if (!clientCode) {
            res.status(400).send({ err: 'no client code included' });
            return;
        }

        pendingMap[clientCode] = verifyCode;
        setTimeout(()=>{delete pendingMap[clientCode];},1000 * 60); // delete pending verifications after one minute
        console.log(`issued verify code for ${debugUname}: project=${getAuthProjectId()} code=${verifyCode}`);
        res.send({ code: verifyCode, project: getAuthProjectId() });
    });

    app.get('/verify/userToken', async (req, res) => { // ?code=000000&method=cloud|CLOUDs
        try {
            let clientCode = req.query.code;
            if (!clientCode) { res.send({ err: 'no client code included' }); return; }
            let tempCode = pendingMap[clientCode];

            if (!tempCode) {
                res.send({ err: 'client code not found', clientCode });
                return;
            }

            console.log(`waiting for verification cloud for ${req.headers.uname}: code=${tempCode}`);
            let cloud = await waitForVerificationCloud(tempCode);
            if (cloud?.code == 'nocon') {
                grantFreePass(req.headers.uname);
                logAuth(req.headers.uname, true, 'verify', 'server couldn\'t query cloud');
                res.send({ freepass: true });
                return;
            }
            if (!cloud) {
                res.send({ err: 'no cloud' });
                logAuth(req.headers.uname, false, 'verify', 'no cloud var found');
                return;
            }
            console.log('cloud', cloud);
            delete pendingMap[clientCode];

            let username = cloud.user;
            let token = (await userManagerr.getUser(username))?.token;
            if (!token) {
                res.send({ err: 'user not found', username });
                logAuth(username, false, 'verify', 'user not stored in database');
                return;
            }

            deleteFreePass(username);
            res.send({ token, username });
            logAuth(username, true, 'verify', 'success');
            return;
        } catch (err) {
            console.error('verification route failed', err);
            res.status(500).send({ err: 'verification route failed' });
        }
    });
    app.post('/verify/recordError',(req,res)=>{
        let message = req.body.msg;
        let username = req.headers.uname;
        logAuth(username,false,'set cloud',message);
        console.log('msg',message);
        res.end();
    });
}

let cachedCloud = [];
let cachedTime = 0;
let CLOUD_CHECK_RATELIMIT = 1000 * 2; // every 2 seconds

async function checkCloud() {
    try {
        cachedCloud = await (await fetch(`https://clouddata.scratch.mit.edu/logs?projectid=${getAuthProjectId()}&limit=40&offset=0&rand=${Math.random()}`)).json();
        cachedTime = Date.now();
        return cachedCloud;
    } catch (e) {
        console.error(e);
        cachedCloud = { code: 'nocon' };
        idIndex = (idIndex + 1) % authProjects.length;
        return cachedCloud;
    }
}
let checkCloudPromise = null;
async function queueCloudCheck() {
    if (checkCloudPromise) { return checkCloudPromise; }
    return checkCloudPromise = new Promise(res => setTimeout(async () => {
        await checkCloud();
        checkCloudPromise = null;
        res(cachedCloud);
    }, CLOUD_CHECK_RATELIMIT));
}
async function checkCloudRatelimited() {
    if (Date.now() - cachedTime < CLOUD_CHECK_RATELIMIT) {
        return await queueCloudCheck();
    } else {
        return await checkCloud();
    }
}

async function getVerificationCloud(tempCode) {
    let vars = await checkCloudRatelimited();
    if (vars?.code) { return { code: 'nocon' }; };
    let cloud = vars?.map(cloudObj => ({ content: cloudObj?.value, user: cloudObj?.user }));
    cloud = cloud.filter(com => String(com.content) == String(tempCode)).reverse()[0];
    return cloud;
}


// export let freePasses = {} // username : passtime

export let freePasses = {};
export async function loadFreePasses() {
    const stored = await loadConfig('freePasses', {});
    Object.assign(freePasses, stored);
}
export async function saveFreePasses() {
    await saveConfig('freePasses', freePasses);
}
// grant temporary free verification to users if the livescratch server fails to verify
export function grantFreePass(username) {
    console.error('granted free pass to user ' + username);
    username = username?.toLowerCase?.();
    freePasses[username] = Date.now();
}
export function hasFreePass(username) {
    username = username?.toLowerCase?.();
    return username in freePasses;
}
export function deleteFreePass(username) {
    username = username?.toLowerCase?.();
    if (username in freePasses) {
        console.error('removing free pass from user ' + username);
        delete freePasses[username];
    }
}


export async function authenticate(username, token, bypassBypass) {
    if (!bypassBypass) { return true; }
    if(!username) { console.error(`undefined username attempted to authenticate with token ${token}`); return '*';}
    let success = hasFreePass(username) || (await userManager.getUser(username)).token == token;
    if (success) {
        logAuth(username, true, 'authenticate');
        // mark as active
        if(!hasFreePass(username)) { (await userManager.getUser(username)).verified = true; }
    } else {
        logAuth(username, false, 'authenticate', `failed to authenticate with token "${token}"`);
        // console.error(`🟪 User Authentication failed for user: ${username}, bltoken: ${token}`)

    }
    return success;
}

export let numWithCreds = 0;
export let numWithoutCreds = 0;
export async function fullAuthenticate(username,token,lsId,bypassAuth) {
    if(token) {numWithCreds++;}
    else {numWithoutCreds++;}
    if(!username) { console.error(`undefined username attempted to authenticate on project ${lsId} with token ${token}`); username = '*';}
    let userAuth = await authenticate(username,token,bypassAuth);
    let isUserbypassAuth = (!bypassAuth);
    let authAns = ((userAuth || isUserbypassAuth)) && (await sessionManager.canUserAccessProject(username,lsId) ||
          admin.includes(username));
    if(!authAns && (userAuth || isUserbypassAuth)) {
        console.error(`🟪☔️ Project Authentication failed for user: ${username}, lstoken: ${token}, lsId: ${lsId}`);
    }
    return authAns;
}
