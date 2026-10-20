"""Exact task unload/restart regression against a private loopback server only.

Run from the repository root. LIFECYCLE_RECEIPT selects a new evidence directory;
LIFECYCLE_STOP_ONLY limits a retry to the stop/projection regression.
LIFECYCLE_BOUNDARY selects one teardown boundary for a focused follow-up.
"""
import sys, json, time, subprocess, hashlib, os
from pathlib import Path

root = Path.cwd()
sys.path.insert(0, str(root / 'scripts'))
source = (root / 'scripts/verify-heartbeat.py').read_text().split('\ntry:\n    # Keep')[0]
source = source.replace('root = Path(__file__).resolve().parent.parent', 'root = Path(' + repr(str(root)) + ')')
destination = '.audit/recovery/lifecycle-fix/' + os.environ.get('LIFECYCLE_RECEIPT', 'native')
sys.argv[1:] = ['--artifacts', str(root / destination)]
exec(compile(source, str(root / 'scripts/verify-heartbeat.py'), 'exec'))
paths = [root / p for p in ['src/workflow-engine.ts', 'src/workflow-types.ts', 'src/heartbeat-policy.ts', 'src/heartbeat-rpc.ts', 'src/heartbeat.ts', 'bin/op-threads-heartbeat.mjs', 'scripts/verify-workflow-lifecycle.py', 'scripts/verify-heartbeat.py', 'scripts/sandbox.py', 'scripts/fixture.py']]
receipt = {'probe': 'explicit native task invalidation and graceful isolated restart; NOT automatic TTL proof', 'hashes': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}}
(artifacts / 'source-before.json').write_text(json.dumps(receipt, indent=2))
started = time.time()
try:
    original = sandbox_module.tempfile.mkdtemp
    sandbox_module.tempfile.mkdtemp = lambda prefix, dir: original(prefix=prefix, dir=artifacts)
    try:
        sandbox = IsolatedSandbox(config(root, provider), artifacts)
    finally:
        sandbox_module.tempfile.mkdtemp = original
    sandbox.await_plugin()
    owner = sandbox.api('POST', '/api/session', {}, location=sandbox.directory)['data']['id']
    host = sandbox.root / 'external-host'; host.mkdir()
    config_file = sandbox.root / 'runner.json'
    config_file.write_text(json.dumps({'protocol': 1, 'serviceFile': str(sandbox.root / 'state/opencode/service.json'), 'hostDirectory': str(host), 'node': subprocess.check_output(['which', 'node'], text=True).strip(), 'runner': str(runner), 'intervalMs': 60000, 'label': label, 'launchAgentsDirectory': str(sandbox.root / 'launchagents')}))

    def snapshot():
        return sandbox.api('POST', '/api/rpc/workflows-heartbeat/snapshot', {'input': {}}, location=host)['output']

    def entry(monitor):
        return next(item for item in snapshot()['entries'] if item['record']['monitorID'] == monitor)

    def enrolled_run(key, reviewer='coordinator'):
        run = tool(owner, 'workflows_start', {'key': key, 'script': 'export const meta = { name: "' + key + '", description: "isolated lifecycle regression" }; return await checkpoint("Inspect", { key: "inspect", reviewer: "' + reviewer + '" });'})
        monitor = tool(owner, 'workflows_heartbeat_enroll', {'key': key, 'runID': run['id'], 'policy': {'cooldownMs': 1000, 'idleGraceMs': 1000, 'stalledMs': 1000}})
        return run, monitor

    def capture(name):
        data = {'snapshot': snapshot(), 'inbox': sandbox.api('GET', f'/api/session/{owner}/inbox'), 'messages': sandbox.api('GET', f'/api/session/{owner}/message?limit=100'), 'active': sandbox.api('GET', '/api/session/active')}
        (artifacts / (name + '.json')).write_text(json.dumps(data, indent=2))
        return data

    receipt['ownerID'] = owner
    receipt['trials'] = []
    boundaries = [os.environ['LIFECYCLE_BOUNDARY']] if os.environ.get('LIFECYCLE_BOUNDARY') else ['task-unload', 'graceful-restart', 'config-reload']
    for boundary in ([] if os.environ.get('LIFECYCLE_STOP_ONLY') else boundaries):
        run, monitor = enrolled_run(boundary)
        task = Path(run['directory'])
        check('exact task directory, not coordinator child: ' + boundary, task == sandbox.root and task != sandbox.directory)
        if boundary == 'task-unload':
            sandbox.api('DELETE', '/api/debug/location', location=task)
        elif boundary == 'graceful-restart':
            sandbox.stop(); sandbox.start(); sandbox.await_plugin()
        elif boundary == 'config-reload':
            pid = sandbox.process.pid
            config_path = sandbox.root / 'config/opencode/opencode.json'
            configuration = json.loads(config_path.read_text())
            configuration['plugins'] = [{'package': str(root), 'options': {'maxWorkers': 2}}]
            (artifacts / 'isolated-config-before.json').write_text(config_path.read_text())
            config_path.write_text(json.dumps(configuration))
            (artifacts / 'isolated-config-after.json').write_text(config_path.read_text())
            def reloaded():
                try:
                    current = entry(monitor['monitorID'])['run']
                    return current if current['status'] == 'interrupted' else False
                except RuntimeError:
                    return False
            eventually(reloaded)
            check('actual Threads options hot-reload without PID replacement', sandbox.process.pid == pid and sandbox.process.poll() is None)
            receipt['hotReload'] = {'pidBefore': pid, 'pidAfter': sandbox.process.pid, 'isolatedConfig': str(config_path), 'optionChange': {'maxWorkers': 2}}
        else:
            raise ValueError('Unknown lifecycle boundary: ' + boundary)
        interrupted = entry(monitor['monitorID'])['run']
        check('typed generic teardown provenance: ' + boundary, interrupted['status'] == 'interrupted' and interrupted['interruption']['kind'] == 'engine-disposed' and interrupted['interruption']['priorStatus'] == 'waiting')
        time.sleep(1.2)
        shadow = cli('once', '--shadow')
        decision = next(item for item in shadow['decisions'] if item['monitorID'] == monitor['monitorID'])
        check('Node shadow lifecycle inspection eligible: ' + boundary, decision['decision']['kind'] == 'wake')
        applied = cli('once')
        wake = next(item for item in applied['decisions'] if item['monitorID'] == monitor['monitorID'])
        check('one exact reserved reminder: ' + boundary, wake['wakesReserved'] == 1 and len(wake['admissions']) == 1)
        identity = {'operation': 'reminder', 'input': {'monitorID': monitor['monitorID'], 'sequence': 1}}
        # workflowHash canonicalizes object keys recursively.
        expected = 'msg_' + hashlib.sha256(json.dumps(identity, separators=(',', ':'), sort_keys=True).encode()).hexdigest()[:32]
        message_id = wake['admissions'][0]['messageID']
        check('deterministic exact reminder ID: ' + boundary, message_id == expected)
        def promoted():
            try:
                return sandbox.api('GET', f'/api/session/{owner}/message/{message_id}')['data']
            except RuntimeError:
                return False
        message = eventually(promoted)
        check('promoted without owner prompt: ' + boundary, message['type'] == 'synthetic' and message['metadata']['heartbeatMonitorID'] == monitor['monitorID'])
        eventually(lambda: owner not in sandbox.api('GET', '/api/session/active')['data'])
        after = capture(boundary + '-after')
        unchanged = entry(monitor['monitorID'])['run']
        check('inspection did not resume, answer, replay or report: ' + boundary, unchanged['status'] == 'interrupted' and unchanged['sessionIDs'] == [] and unchanged['checkpoints'][0].get('response') is None)
        receipt['trials'].append({'boundary': boundary, 'runID': run['id'], 'monitorID': monitor['monitorID'], 'messageID': message_id, 'interrupted': interrupted, 'shadow': shadow, 'tick': applied})
        tool(owner, 'workflows_heartbeat_stop', {'key': boundary, 'expectedRevision': wake['revision'], 'reason': 'isolated trial complete, not workflow acceptance'})

    human, hm = enrolled_run('human-held', 'human')
    sandbox.api('DELETE', '/api/debug/location', location=Path(human['directory']))
    time.sleep(1.2)
    hd = next(item for item in cli('once', '--shadow')['decisions'] if item['monitorID'] == hm['monitorID'])
    check('interrupted native human gate stays held', hd['decision']['reason'] == 'human or legacy checkpoint')
    tool(owner, 'workflows_control', {'runID': human['id'], 'action': 'stop'})
    time.sleep(1.2)
    capture('after-explicit-stop')
    stopped = next(item for item in cli('once', '--shadow')['decisions'] if item['monitorID'] == hm['monitorID'])
    check('explicit workflow stop stays held', stopped['decision']['kind'] == 'hold' and entry(hm['monitorID'])['run']['status'] == 'stopped' and entry(hm['monitorID'])['run'].get('interruption') is None)
    receipt['complete'] = True
finally:
    if sandbox:
        sandbox.stop(); receipt['isolatedServiceStopped'] = sandbox.process.poll() is not None
    provider.close()
    receipt['checks'] = checks
    receipt['durationSeconds'] = time.time() - started
    receipt['sourceUnchanged'] = all(hashlib.sha256(p.read_bytes()).hexdigest() == receipt['hashes'][str(p.relative_to(root))] for p in paths)
    (artifacts / 'receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt, indent=2))
