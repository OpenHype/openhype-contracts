// Verifies the deployment in deployments/<network>-card.json on OKLink through its keyless,
// Etherscan-style plugin API: the implementation's source (only the files it compiles from, so test
// fixtures are never published), the ERC1967Proxy's source (constructor arguments read from the
// deploy transaction), then links the proxy to its implementation. Re-running is harmless.
const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');

const CHAIN_SHORT_NAMES = { 1952n: 'XLAYER_TESTNET', 196n: 'XLAYER' };
const CONTRACT = 'OpenHypeCollectible';
const SOURCE = `src/${CONTRACT}.sol`;
const PROXY_BUILD = require.resolve('@openzeppelin/upgrades-core/artifacts/build-info-v5.json');
const PROXY_SOURCE = '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  const chain = CHAIN_SHORT_NAMES[chainId];
  if (!chain) throw new Error(`No OKLink chain for ${chainId}`);
  const api = `https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/${chain}`;
  const report = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../deployments/${network.name}-card.json`), 'utf8'));

  const impl = minimalInput(latestBuild(SOURCE), SOURCE, CONTRACT);
  await verifySource(api, { address: report.implementation, name: `${SOURCE}:${CONTRACT}`, ...impl, args: '' });

  if (process.env.VERIFY_PROXY_SOURCE !== 'no') {
    const build = JSON.parse(fs.readFileSync(PROXY_BUILD, 'utf8'));
    const proxy = minimalInput(build, PROXY_SOURCE, 'ERC1967Proxy');
    const bytecode = '0x' + build.output.contracts[PROXY_SOURCE].ERC1967Proxy.evm.bytecode.object;
    const tx = await ethers.provider.getTransaction(report.deployTx);
    if (!tx || !tx.data.startsWith(bytecode)) throw new Error('Deploy transaction does not carry the ERC1967Proxy bytecode');
    await verifySource(api, { address: report.proxy, name: `${PROXY_SOURCE}:ERC1967Proxy`, ...proxy, args: tx.data.slice(bytecode.length) });
  }

  const linked = await call(api, { module: 'contract', action: 'verifyproxycontract', address: report.proxy, expectedimplementation: report.implementation });
  console.log(JSON.stringify({ proxy: report.proxy, link: await poll(api, 'checkproxyverification', linked.result) }));
}

/** The newest Hardhat build that compiled the contract. */
function latestBuild(source) {
  const dir = path.resolve(__dirname, '../artifacts/build-info');
  const builds = fs.readdirSync(dir).map(f => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .map(f => JSON.parse(fs.readFileSync(f, 'utf8')))
    .filter(b => b.output?.contracts?.[source]);
  if (!builds.length) throw new Error('Compile first (npx hardhat compile)');
  return builds[0];
}

/** Standard JSON input restricted to the sources the contract's metadata lists. */
function minimalInput(build, source, name) {
  const meta = JSON.parse(build.output.contracts[source][name].metadata);
  const input = { ...build.input, sources: Object.fromEntries(Object.entries(build.input.sources).filter(([f]) => f in meta.sources)) };
  return { input, compiler: `v${build.solcLongVersion.replace(/\.Emscripten.*$/, '')}` };
}

async function verifySource(api, { address, name, input, compiler, args }) {
  const submitted = await call(api, {
    module: 'contract', action: 'verifysourcecode', contractaddress: address, codeformat: 'solidity-standard-json-input',
    contractname: name, compilerversion: compiler, sourceCode: JSON.stringify(input), constructorArguements: args, licenseType: '3',
  }, true);
  if (submitted.alreadyVerified) return console.log(JSON.stringify({ address, name, source: 'already verified' }));
  console.log(JSON.stringify({ address, name, source: await poll(api, 'checkverifystatus', submitted.result) }));
}

async function call(api, params, tolerateVerified = false) {
  const response = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const body = await response.json().catch(() => ({}));
  if (body.status === '1') return body;
  if (tolerateVerified && /already verified/i.test(`${body.result} ${body.message}`)) return { alreadyVerified: true };
  throw new Error(`OKLink ${params.action}: ${body.message ?? response.status} ${body.result ?? ''}`);
}

async function poll(api, action, guid) {
  for (let i = 0; i < 30; i++) {
    const { result = '' } = await call(api, { module: 'contract', action, guid }).catch(error => ({ result: error.message }));
    if (/pass|verified/i.test(result)) return result;
    if (/fail/i.test(result)) throw new Error(`${action}: ${result}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error(`${action}: no result for ${guid}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
