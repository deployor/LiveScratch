import { Filter } from './utils/profanity-filter.js';
import { postText } from './utils/discord-webhook.js';
import { addRecent} from './utils/recentUsers.js';
import {fullAuthenticate} from './utils/scratch-auth.js';
import * as fileStorageUtils from './utils/fileStorage.js';
const admin = JSON.parse(process.env.ADMIN);

export default class initSockets {
    constructor(ioHttp, sessionManager, userManager) {
        this.filter = new Filter();

        this.sessionManager = sessionManager;
        this.userManager = userManager;

        this.messageHandlers = {
            'joinSession': async (data,client)=>{
                if(!await fullAuthenticate(data.username,data.token,data.id)) {
                    console.error(`🚫 joinSession auth failed  user=${data.username}  id=${data.id}`);
                    client.send({noauth:true}); return;
                }
    
                await this.sessionManager.join(client,data.id,data.username);
                if(data.pk) { (await this.userManager.getUser(data.username)).pk = data.pk; }
            },'joinSessions': async (data,client)=>{
                if(!await fullAuthenticate(data.username,data.token,data.id)) {
                    console.error(`🚫 joinSessions auth failed  user=${data.username}  id=${data.id}`);
                    client.send({noauth:true}); return;
                }
    
                for (const id of data.ids) { await this.sessionManager.join(client,id,data.username); }
                if(data.pk) { (await this.userManager.getUser(data.username)).pk = data.pk; }
            },
            'leaveSession': async (data,client)=>{
                await this.sessionManager.leave(client,data.id);
            },
            'projectChange': async (data,client,callback)=>{
                if(!await fullAuthenticate(data.username,data.token,data.blId)) {client.send({noauth:true}); return;}
    
                await this.sessionManager.projectChange(data.blId,data,client);
                callback(await this.sessionManager.getVersion(data.blId));
            },
            'setTitle': async (data,client)=>{
                if(!await fullAuthenticate(data.username,data.token,data.blId)) {client.send({noauth:true}); return;}
    
                let project = await this.sessionManager.getProject(data.blId);
                if(!project) {return;}
                project.project.title = data.msg.title;
                project.session.sendChangeFrom(client,data.msg,true);
            },
            'setCursor':(data,client)=>{ // doesnt need to be authenticated because relies on pre-authenticated join action
                // getProject is async; use in-memory only for perf (cursor update is non-critical)
                let project = this.sessionManager.livescratch[data.blId];
                if(!project) {return;}
                let cursor = project.session.getClientFromSocket(client)?.cursor;
                if(!cursor) {return;}
                Object.entries(data.cursor).forEach(e=>{
                    if(e[0] in cursor) { cursor[e[0]] = e[1]; }
                });
            },
            'chat': async (data,client)=>{
                const BROADCAST_KEYWORD = 'toall ';
    
                delete data.msg.msg.linkify;
                let text = String(data.msg.msg.text);
                let sender = data.msg.msg.sender;
                let project = await this.sessionManager.getProject(data.blId);
    
                if(!await fullAuthenticate(sender,data.token,data.blId,true)) {client.send({noauth:true}); return;}
                if(admin.includes(sender?.toLowerCase()) && text.startsWith(BROADCAST_KEYWORD)) {
                    let broadcast=text.slice(BROADCAST_KEYWORD.length);
                    console.log(`broadcasting message to all users: "${broadcast}" [${sender}]`);
                    postText(`broadcasting message to all users: "${broadcast}" [${sender}]`);
                    this.sessionManager.broadcastMessageToAllActiveProjects(`${broadcast}`);
                }
                
                const isVulgar = await this.filter.isVulgar(text);
                if(isVulgar) {
                    let sentTo = project.session.getConnectedUsernames().filter(uname=>uname!=sender?.toLowerCase());
                    let loggingMsg = '🔴 FILTERED CHAT: ' + '"' + text + '" [' + sender + '->' + sentTo.join(',') + ' | scratchid: ' + project.scratchId + ']';
                    
                    text = await this.filter.getCensored(text);
                    data.msg.msg.text = text;
                    
                    loggingMsg = loggingMsg + `\nCensored as: "${text}"`;
                    console.error(loggingMsg);
                    postText(loggingMsg);
                }
    
                let banned = await fileStorageUtils.getBanned();
                if(banned?.includes?.(sender)) {return;}
    
                project?.onChat(data.msg,client);
                // logging
                let sentTo = project.session.getConnectedUsernames().filter(uname=>uname!=sender?.toLowerCase());
                let loggingMsg = '"' + text + '" [' + sender + '->' + sentTo.join(',') + ' | scratchid: ' + project.scratchId + ']';
                console.log(loggingMsg);
                postText(loggingMsg);
            },
        };

        this.ioHttp = ioHttp;
        this.ioHttp.on('connection', this.onSocketConnection.bind(this));
    }

    onSocketConnection(client) {
        const rawIp = client.handshake.headers['x-forwarded-for'] ?? client.handshake.address;
        const ip = String(rawIp).split(',')[0].trim();
        console.log(`🔌 socket connected    id=${client.id}  ip=${ip}`);

        client.on('message', async (data,callback)=>{
            if(data.type in this.messageHandlers) {

                // record analytic first to stop reloading after project leave
                analytic: try{
                    let id = data.blId ?? data.id ?? null;
                    if (!id) { break analytic; }
                    let project = await this.sessionManager.getProject(id);
                    if (!project) { break analytic; }
                    let connected = project.session?.getConnectedUsernames();
                    connected?.forEach?.(username => {
                        addRecent(username, connected.length>1, project.sharedWith.length);
                    });
                } catch (e) { console.error('error with analytic message tally'); console.error(e); }

                try{await this.messageHandlers[data.type](data,client,callback);}
                catch(e){console.error('error during messageHandler',e);}
            } else { console.log('discarded unknown message type: ' + data.type); }
        });

        client.on('disconnect', async (reason)=>{
            const username = this.sessionManager.socketMap[client.id]?.username ?? 'unknown';
            console.log(`🔌 socket disconnected id=${client.id}  user=${username}  reason=${reason}`);
            await this.sessionManager.disconnectSocket(client);
        });
    }
}