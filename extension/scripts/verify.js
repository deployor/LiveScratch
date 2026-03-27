function askVerify() {
    (async () => {
        const info = await chrome.runtime.sendMessage({ meta: 'getUsernamePlus' });
        chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'askVerify getUsernamePlus', payload: info });

        if (!info?.signedin || !info?.uname || info.uname === '*') {
            chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'askVerify aborted: no signed in Scratch user', payload: info });
            return;
        }

        if (info.currentBlToken) {
            chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'askVerify skipped: token already exists' });
            return;
        }

        const clientCode = Math.random().toString();
        chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'askVerify clientCode', payload: clientCode });

        const response = await fetch(`${info.apiUrl}/verify/start?code=${clientCode}`, {
            headers: { uname: info.uname },
        });
        const verifyResponse = await response.json();

        console.log('askVerify response', verifyResponse);
        chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'askVerify response', payload: verifyResponse });
        if(!verifyResponse?.code || !verifyResponse?.project) {return;}

        chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'askVerify storing clientCode in background', payload: clientCode });
        await chrome.runtime.sendMessage({ meta: 'setVerifyClientCode', clientCode });

        let res = await setCloudTempCode(verifyResponse.code, verifyResponse.project);
        console.log('setCloudTempCode result', res);
        chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'setCloudTempCode result', payload: res });
        chrome.runtime.sendMessage({ meta: 'setCloud', res });
    })().catch((error) => {
        console.error('askVerify failed', error);
        chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'askVerify failed', payload: String(error?.stack || error) });
    });
}
askVerify();

async function setCloudVar(value, AUTH_PROJECTID) { 
    const user = await chrome.runtime.sendMessage({ meta: 'getUsername' });
    if(user=='*') {return {err:'livescratch thinks you are logged out'};}
    console.log('setCloudVar start', { value, AUTH_PROJECTID, user });
    chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'setCloudVar start', payload: { value, AUTH_PROJECTID, user } });
    const connection = new WebSocket('wss://clouddata.scratch.mit.edu');

    let setAndClose = new Promise((res) => {
        let finished = false;
        let timeout = setTimeout(() => {
            if (finished) { return; }
            finished = true;
            console.error('verify websocket timed out before completion');
            chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'verify websocket timeout' });
            try { connection.close(); } catch {}
            res({err:'verify websocket timed out'});
        }, 8000);

        function finish(result) {
            if (finished) { return; }
            finished = true;
            clearTimeout(timeout);
            res(result);
        }

        try{

            connection.onerror = function (error) {
                console.error('WebSocket error:', error);
                chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'verify websocket error', payload: String(error) });
                connection.close();
                finish({err:error});
            };

            connection.onclose = function (event) {
                console.log('verify websocket closed', event.code, event.reason);
                chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'verify websocket closed', payload: { code: event.code, reason: event.reason } });
            };

            connection.onopen = async () => {
                console.log('verify websocket opened');
                chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'verify websocket opened' });
                connection.send(
                    JSON.stringify({ method: 'handshake', project_id: AUTH_PROJECTID, user }) + '\n');
                await new Promise((r) => setTimeout(r, 100));
                connection.send(
                    JSON.stringify({
                        value: value.toString(),
                        name: '☁ verify',
                        method: 'set',
                        project_id: AUTH_PROJECTID,
                        user,
                    }) + '\n',
                );
                console.log('verify websocket sent cloud value');
                chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'verify websocket sent cloud value' });
                connection.close();
                finish({ok:true});
                return {ok:true};
            };
        } catch(e) {
            chrome.runtime.sendMessage({ meta: 'verifyDebug', stage: 'setCloudVar catch', payload: String(e?.stack || e) });
            finish({err:e});
        }
    });
    return await setAndClose;
}


async function setCloudTempCode(code, projectInfo) {
    let response = await setCloudVar(code, projectInfo);
    if(response.err instanceof Error) {response.err = response.err.stack;}
    return response;
}


// observe login

const targetNode = document.querySelector('.registrationLink')?.parentNode?.parentNode;

if (targetNode) { // only add the listener on the logged out page
    // Options for the observer (which mutations to observe)
    const config = { attributes: true, childList: true, subtree: true };

    // Callback function to execute when mutations are observed
    const callback = (mutationList, observer) => {
        for (const mutation of mutationList) {
            if (mutation.addedNodes?.[0]?.classList.contains('account-nav')) {
                console.log('ls login detected');
                askVerify();
            }
        }
    };

    // Create an observer instance linked to the callback function
    const observer = new MutationObserver(callback);

    // Start observing the target node for configured mutations
    observer.observe(targetNode, config);
}
