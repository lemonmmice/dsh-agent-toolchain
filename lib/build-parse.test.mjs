// lib/build-parse.test.mjs — build runner output parsing self-test:
// top-level MSB errors (no line/col) must never vanish from the structured
// list, and the shared GBK-aware decoder must round-trip CN-locale text.
import { makeBuilder } from '../plugins/dsh-build/lib/builder.mjs'
import { decodeBuffer } from '../lib/decode.mjs'
import { tmpdir } from 'node:os'

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log('  ok - ' + msg)
  else {
    failures++
    console.error('  FAIL - ' + msg)
  }
}

const b = makeBuilder({ clientRoot: 'C:/does-not-exist', logsDir: tmpdir() })

// 1. top-level MSB error + positioned error + warning in one stream
const { errors, warnings } = b.parseErrors(
  'MSBUILD : error MSB1009: 项目文件不存在。\n' +
    'Foo.cs(12,3): error CS1234: boom\n' +
    'Foo.cs(13,1): warning CS9999: careful\n',
)
ok(errors.length === 2, 'top-level + positioned errors both parsed')
ok(errors.some((e) => e.code === 'MSB1009' && e.file === '(top-level)' && e.message.includes('MSB1009') === false && e.message.length > 0), 'top-level MSB error kept, file marked (top-level)')
ok(errors.some((e) => e.code === 'CS1234' && e.line === 12), 'positioned error keeps line info')
ok(warnings.length === 1 && warnings[0].code === 'CS9999', 'warning parsed')

// 2. english top-level form
const en = b.parseErrors('MSBUILD : error MSB4126: The solution configuration "Debug|x86" is invalid.')
ok(en.errors.length === 1 && en.errors[0].code === 'MSB4126', 'english top-level MSB error parsed')

// 2b. dotnet/NuGet positionless form: "Foo.csproj : error NU1301: …"
const nu = b.parseErrors(
  'C:\\repo\\Foo.csproj : error NU1301: 无法加载源 https://api.nuget.org/v3/index.json\n' +
    '  由于目标计算机积极拒绝，无法连接。 (127.0.0.1:6518) [C:\\repo\\Foo.csproj]\n',
)
ok(nu.errors.length === 1 && nu.errors[0].code === 'NU1301' && nu.errors[0].file.endsWith('Foo.csproj'), 'positionless NU error parsed, continuation line ignored')

// 2c. MSBuild prints each error twice (inline + summary block): dedupe
const dup = b.parseErrors(
  'Foo.cs(12,3): error CS1525: boom\nFoo.cs(12,3): error CS1525: boom\nMSBUILD : error MSB1009: nope\nMSBUILD : error MSB1009: nope\n',
)
ok(dup.errors.length === 2, 'duplicate error lines deduped (4 printed -> 2 unique)')

// 3. shared decoder: UTF-8 and GBK round-trips
const utf8 = decodeBuffer(Buffer.from('构建完成', 'utf8'))
ok(utf8.enc === 'utf-8' && utf8.text === '构建完成', 'decodeBuffer utf-8 round-trip')
// GBK bytes for "中文" (D6 D0 CE C4) are invalid UTF-8 (0xD0 is not a valid
// continuation after 0xD6), so the decoder must fall back to GBK.
const gbk = decodeBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
ok(gbk.enc === 'gbk' && gbk.text === '中文', 'decodeBuffer GBK fallback round-trip')

if (failures > 0) {
  console.error(`\nBUILD-PARSE TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nBUILD-PARSE TEST PASSED')
