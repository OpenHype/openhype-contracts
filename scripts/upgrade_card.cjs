// Upgrades the OpenHypeCollectible proxy recorded in deployments/<network>-card.json to the current source.
// The OZ plugin validates storage-layout compatibility against .openzeppelin/ before sending anything.
//
// Testnet: the signer holds DEFAULT_ADMIN_ROLE and upgrades directly.
// Mainnet (network xlayer), EOA admin: the signer must be that admin; upgrades directly after
// CONFIRM_MAINNET=yes.
// Mainnet, Safe admin: deploys and validates the new implementation (prepareUpgrade), records it as
// pendingUpgrade and prints the Safe transaction to execute. Run it again after the Safe executed: it
// confirms the proxy moved and records the upgrade.
// CARD_SET_OWNER=<address> also calls setOwner(address) inside the upgrade transaction (upgradeToAndCall).
const fs = require('node:fs');
const path = require('node:path');
const { ethers, upgrades, network } = require('hardhat');

const MAINNET = 196n;

async function main() {
  const file = path.resolve(__dirname, `../deployments/${network.name}-card.json`);
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const Card = await ethers.getContractFactory('OpenHypeCollectible');
  const before = await upgrades.erc1967.getImplementationAddress(report.proxy);
  const { chainId } = await ethers.provider.getNetwork();
  const owner = process.env.CARD_SET_OWNER ? ethers.getAddress(process.env.CARD_SET_OWNER) : null;
  const call = owner ? { fn: 'setOwner', args: [owner] } : undefined;
  if (chainId === MAINNET) {
    const [signer] = await ethers.getSigners();
    const adminIsEoa = (await ethers.provider.getCode(report.admin)) === '0x';
    if (!adminIsEoa) return proposeViaSafe(file, report, Card, before, call);
    if (signer.address !== report.admin) throw new Error(`The admin ${report.admin} is an EOA: sign with it (signer is ${signer.address})`);
    console.log(JSON.stringify({ proxy: report.proxy, admin: report.admin, from: before, setOwner: owner }));
    if (process.env.CONFIRM_MAINNET !== 'yes') throw new Error('Re-run with CONFIRM_MAINNET=yes to upgrade the mainnet proxy.');
  }

  const card = await upgrades.upgradeProxy(report.proxy, Card, { kind: 'uups', timeout: 120000, call });
  await card.waitForDeployment();
  // Public X Layer RPC nodes lag each other: wait until reads see the new implementation.
  let after = before;
  for (let i = 0; i < 30 && after === before; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    after = await upgrades.erc1967.getImplementationAddress(report.proxy);
  }
  if (after === before) throw new Error('Implementation did not change; check the upgrade transaction');
  report.implementation = after;
  report.upgrades = [...(report.upgrades || []), { at: new Date().toISOString(), from: before, to: after, ...(owner ? { setOwner: owner } : {}) }];
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  if (owner) {
    // Same lagging-node caveat as the implementation read above.
    let current = null;
    for (let i = 0; i < 30 && current !== owner; i++) {
      current = await card.owner();
      if (current !== owner) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (current !== owner) throw new Error(`owner() is ${current}, expected ${owner}`);
  }
  const domain = await card.eip712Domain();
  console.log(JSON.stringify({ proxy: report.proxy, from: before, to: after, eip712: { name: domain.name, version: domain.version } }, null, 2));
}

async function proposeViaSafe(file, report, Card, current, call) {
  const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  const pending = report.pendingUpgrade;
  if (pending && current.toLowerCase() === pending.to.toLowerCase()) {
    report.implementation = current;
    report.upgrades = [...(report.upgrades || []), { at: new Date().toISOString(), from: pending.from, to: current, via: 'safe' }];
    delete report.pendingUpgrade;
    save();
    console.log(JSON.stringify({ proxy: report.proxy, upgraded: true, implementation: current }, null, 2));
    return;
  }
  const implementation = await upgrades.prepareUpgrade(report.proxy, Card, { kind: 'uups', timeout: 120000 });
  const init = call ? Card.interface.encodeFunctionData(call.fn, call.args) : '0x';
  const data = Card.interface.encodeFunctionData('upgradeToAndCall', [implementation, init]);
  report.pendingUpgrade = { at: new Date().toISOString(), from: current, to: implementation };
  save();
  console.log(JSON.stringify({
    safe: report.admin,
    transaction: { to: report.proxy, value: '0', data },
    note: 'Execute this from the admin Safe, then run this script again to record the upgrade.',
    newImplementation: implementation,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
