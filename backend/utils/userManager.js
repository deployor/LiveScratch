// user:
//  friends LIST of STRING
//  projects owned by user LIST of 
//  projects shared to user LIST
//     > livescratch id
//     > from user
//  scratch id (pk- "primary key")
//

import { saveMapToFolder, usersPath } from './fileStorage.js';
import { getCollection } from './db.js';

const OFFLOAD_TIMEOUT_MILLIS = 30 * 1000;

export default class UserManager {

    // removed since dynamic reloading/offloading
    // static fromJSON(json) {
    //     let thing = new UserManager()
    //     thing.users = json.users
    //     return thing
    // }

    users = {};

    verify(username, token) {
        return !!(getUser(username)?.token == token); // 🟢
    }

    async befriend(base, to) {
        console.log(base + ' friending ' + to);
        (await this.getUser(base))?.friends.push(to?.toLowerCase()); // 🚨
    }
    async unbefriend(base, take) {
        console.log(base + ' unfriending ' + take);
        take = take?.toLowerCase();
        (await this.getUser(base))?.friends.splice((await this.getUser(base))?.friends.indexOf(take), 1); // 🚨
    }

    async userExists(username) {
        await this.reloadUser(username);
        return (username?.toLowerCase?.() in this.users);
    }

    async getUser(username) {

        // clear previous timeout
        clearTimeout(this.offloadTimeoutIds[username]);
        delete this.offloadTimeoutIds[username];
        // set new timeout
        let timeout = setTimeout(() => { this.offloadUser(username); }, OFFLOAD_TIMEOUT_MILLIS);
        this.offloadTimeoutIds[username] = timeout;


        await this.reloadUser(username);
        if (!(username?.toLowerCase() in this.users)) {
            await this.addUser(username);
        }
        return this.users[username.toLowerCase()]; // 🟢
    }

    async addUser(username) {
        await this.reloadUser(username);
        if (!(username?.toLowerCase() in this.users)) {
            console.log(`🆕 new user: ${username}`);
            this.users[username.toLowerCase()] = { username, friends: [], token: this.token(), sharedTo: {}, myProjects: [], verified:false, privateMe: false }; // 🚨
        }
        return this.getUser(username);
    }

    offloadTimeoutIds = {};

    async reloadUser(username) {
        if (!username?.toLowerCase) { console.error(`username is not string ${username}`); console.trace(); return; } // username is not a string
        username = username.toLowerCase();

        if (!(username in this.users)) {
            try {
                const col = getCollection('users');
                const doc = await col.findOne({ _id: username });
                if (doc) {
                    this.users[username] = doc.data;
                }
            } catch (e) {
                console.error('reloadUser: error loading user ' + username, e);
            }
        }
    }
    async offloadUser(username) {
        // console.log(`offloading user ${username}`)
        if (!username?.toLowerCase) { console.error(`username is not string ${username}`); console.trace(); return; } // username is not a string
        username = username.toLowerCase();
        if (!(username in this.users)) { return; }
        let usersSave = {};
        usersSave[username] = this.users[username]; // get user object to save
        delete this.users[username]; // delete from ram
        await saveMapToFolder(usersSave, usersPath); // write to MongoDB
    }

    async newProject(owner, blId) {
        console.log(`usrMngr: adding new project ${blId} owned by ${owner}`);
        if ((await this.getUser(owner)).myProjects.indexOf(blId) != -1) { return; }
        (await this.getUser(owner)).myProjects.push(blId);
    }

    async share(username, blId, from) {
        from = from?.toLowerCase();
        console.log(`usrMngr: sharing ${blId} with ${username} from ${from}`);
        let map = (await this.getUser(username))?.sharedTo;
        if (!map) { return; }
        if (blId in map) { return; }
        map[blId] = { from, id: blId };
    }
    async unShare(username, blId) {
        username = username?.toLowerCase();
        console.log(`usrMngr: unsharing ${blId} with ${username}`);
        let map = (await this.getUser(username))?.sharedTo;
        if (!map) { return; }
        delete map[blId];

        let ownedIndex = (await this.getUser(username))?.myProjects.indexOf(blId);
        if (ownedIndex != -1) {
            (await this.getUser(username))?.myProjects.splice(ownedIndex, 1);
        }



    }
    async getSharedObjects(username) {
        return Object.values((await this.getUser(username))?.sharedTo);
    }
    async getShared(username) {
        let user = await this.getUser(username);
        let objs = await this.getSharedObjects(username);
        if (!objs) { return []; }
        return objs.filter((proj) => (user.friends.indexOf(proj.from?.toLowerCase()) != -1)).map((proj) => (proj.id));
    }
    async getAllProjects(username) {
        return (await this.getUser(username)).myProjects.concat(await this.getShared(username));
    }

    rand() {
        return Math.random().toString(36).substring(2); // remove `0.`
    };

    token() {
        return this.rand() + this.rand(); // to make it longer
    };
}