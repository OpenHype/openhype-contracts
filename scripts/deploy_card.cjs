// Deploys the OpenHypeCard UUPS proxy. The deployer only pays gas: admin and relayer come
// from the environment and the deployer keeps no role unless it is explicitly the admin.
// Resumable: an existing report is verified, never redeployed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ethers, upgrades, network } = require('hardhat');

const CHAINS = { xlayerTestnet: 1952n };

async function main() {
  const chainId = CHAINS[network.name];
  if (!chainId || (await ethers.provider.getNetwork()).chainId !== chainId)
    throw new Error(`Unsupported network ${network.name}`);
  const admin = ethers.getAddress(requireEnv('CARD_ADMIN_ADDRESS'));
  const relayer = ethers.getAddress(requireEnv('CARD_RELAYER_ADDRESS'));
  const baseURI = requireEnv('CARD_BASE_URI');
  if (admin === relayer) throw new Error('Admin and relayer must be different keys');
  const [deployer] = await ethers.getSigners();

  const file = path.resolve(__dirname, `../deployments/${network.name}-card.json`);
  const Card = await ethers.getContractFactory('OpenHypeCard');
  await upgrades.validateImplementation(Card, { kind: 'uups' });

  let report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (!report) {
    console.log(JSON.stringify({ chainId: Number(chainId), deployer: deployer.address, admin, relayer, baseURI }));
    const card = await upgrades.deployProxy(Card, [admin, relayer, baseURI], { kind: 'uups', timeout: 120000 });
    report = {
      chainId: Number(chainId),
      proxy: await card.getAddress(),
      deployTx: card.deploymentTransaction().hash,
      admin,
      relayer,
      baseURI,
    };
    // Journal the proxy before waiting, so an interrupted run can reattach instead of redeploying.
    save(file, report);
    await card.waitForDeployment();
    report.implementation = await upgrades.erc1967.getImplementationAddress(report.proxy);
    save(file, report);
  }

  const card = Card.attach(report.proxy);
  assert.equal(await card.hasRole(await card.DEFAULT_ADMIN_ROLE(), report.admin), true, 'admin role');
  assert.equal(await card.hasRole(await card.MINTER_ROLE(), report.relayer), true, 'minter role');
  assert.equal(await card.hasRole(await card.OPERATOR_ROLE(), report.relayer), true, 'operator role');
  if (deployer.address !== report.admin)
    assert.equal(await card.hasRole(await card.DEFAULT_ADMIN_ROLE(), deployer.address), false, 'deployer holds no role');
  assert.equal(await card.paused(), false);
  console.log(JSON.stringify(report, null, 2));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

function save(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
