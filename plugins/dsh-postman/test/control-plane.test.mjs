import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { sendRequest } from '../lib/http.mjs'

let mutations = 0
const fixture = createServer((request, response) => {
  if (request.url === '/redirect') {
    response.writeHead(307, { location: '/api/dsh-ui-drive/approvals/grant' })
    response.end()
  } else if (request.url.startsWith('/api/dsh-ui-drive/')) {
    mutations++
    response.end('allowed')
  } else response.end('ordinary API')
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${fixture.address().port}`
try {
  for (const pathname of ['/api/dsh-ui-drive/approvals/grant', '/api/dsh-ui-drive/estop/reset', '/redirect']) {
    const result = await sendRequest({ method: 'POST', url: base + pathname, body: '{}' })
    assert.equal(result.errorCode, 'control_plane_forbidden')
  }
  assert.equal(mutations, 0)
  assert.equal((await sendRequest({ url: base + '/ordinary' })).ok, true)
  console.log('PASS HTTP control-plane direct and redirect mutations are refused before dispatch')
} finally {
  fixture.closeAllConnections()
  await new Promise(resolve => fixture.close(resolve))
}
