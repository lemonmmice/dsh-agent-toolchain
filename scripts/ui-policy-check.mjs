import { loadControlPolicy, controlDecision, controlPolicyStatus } from '../plugins/dsh-ui-drive/lib/control-policy.mjs'

const argv = process.argv.slice(2)
const option = (name) => { const index = argv.indexOf('--' + name); return index >= 0 ? argv[index + 1] : undefined }
const file = option('policy')
if (!file) throw new Error('usage: ui-policy-check.mjs --policy <file> [--action click --name <name> --aid <aid> --container <container>]')
const policy = loadControlPolicy(file)
console.log(JSON.stringify({ ...controlPolicyStatus(policy), examples: policy.examples ?? [] }, null, 2))
if (option('action')) console.log(JSON.stringify(controlDecision(policy, { action: option('action'), name: option('name'), aid: option('aid'), container: option('container') }), null, 2))
process.exitCode = policy.valid ? 0 : 1
