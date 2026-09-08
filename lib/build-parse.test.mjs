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

// 2d. SDK-resolution chains: positioned-less "file : error CODE:" plus the
// embedded-code form "file : error : MSB4276: …" — pure-prose chain lines
// carry no code and MSBuild's summary does not count them, so they must not
// become phantom errors (parity with the summary count).
const sdk = b.parseErrors(
  'C:\\repo\\Foo.csproj : error MSB4236: 找不到指定的 SDK"Microsoft.NET.Sdk.WindowsDesktop"。\n' +
    'C:\\repo\\Foo.csproj : error : 无法解析 SDK"Microsoft.NET.Sdk.WindowsDesktop"。下面的探测消息中正好有一条指示我们无法解析 SDK 的原因。\n' +
    'C:\\repo\\Foo.csproj : error :   Unable to locate the .NET SDK.\n' +
    'C:\\repo\\Foo.csproj : error :   MSB4276: 默认 SDK 解析程序解析 SDK 失败。\n',
)
ok(sdk.errors.length === 2, 'SDK chain parsed as 2 errors (MSB4236 + embedded MSB4276), prose lines ignored')
ok(sdk.errors.some((e) => e.code === 'MSB4236' && e.file.endsWith('Foo.csproj')), 'MSB4236 kept with file')
ok(sdk.errors.some((e) => e.code === 'MSB4276'), 'embedded MSB4276 extracted from prose chain')

// 2e. environment vs code classification (SDK resolution / NuGet feed
// failures are environment — the agent must not chase them as code bugs)
ok(b.isEnvError({ file: 'Foo.csproj', code: 'MSB4236' }), 'MSB4236 (SDK not found) classified env')
ok(b.isEnvError({ file: 'Foo.csproj', code: 'MSB4276' }), 'MSB4276 (SDK resolver) classified env')
ok(b.isEnvError({ file: 'Foo.csproj', code: 'NU1301' }), 'NU1301 (feed unreachable) classified env')
ok(b.isEnvError({ file: 'Foo.csproj', code: 'NETSDK1045' }), 'NETSDK1045 classified env')
ok(b.isEnvError({ file: 'Foo.csproj', code: 'NETSDK1004' }), 'NETSDK1004 (assets missing) classified env')
ok(!b.isEnvError({ file: 'Foo.cs', code: 'CS1525' }), 'CS1525 stays a code error')
ok(!b.isEnvError({ file: 'Foo.csproj', code: 'NU1102' }), 'NU1102 stays a code error (package identity is code)')

// 2f. six-letter code prefixes (NETSDKxxxx) must parse — MSBuild max code
// prefix length is 6, not 5.
const netsdk = b.parseErrors('C:\\repo\\Microsoft.PackageDependencyResolution.targets(266,5): error NETSDK1004: 找不到资产文件“obj\\project.assets.json”。')
ok(netsdk.errors.length === 1 && netsdk.errors[0].code === 'NETSDK1004' && netsdk.errors[0].line === 266, 'NETSDK1004 parsed with position')

// 2g. code-less warning form (NuGet compat notices): counted honestly with
// code '(none)'; code-less positioned ERROR prose stays out (MSBuild's
// summary does not count it — parity holds).
const codeless = b.parseErrors(
  'C:\\p\\X.targets(4,5): warning : System.ComponentModel.Composition 10.0.11 doesn\'t support net6.0-windows.\n' +
    'C:\\p\\X.targets(4,5): warning : System.ComponentModel.Composition 10.0.11 doesn\'t support net6.0-windows.\n' +
    'C:\\p\\Y.cs(9,1): error : 无法解析 SDK"X"，下面的探测消息说明原因。\n',
)
ok(codeless.warnings.length === 1 && codeless.warnings[0].code === '(none)', 'code-less warning counted once (dedupe), code (none)')
ok(codeless.errors.length === 0, 'code-less positioned error prose not counted')

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
