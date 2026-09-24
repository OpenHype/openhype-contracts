// Upgrades the OpenHypeCollectible proxy recorded in deployments/<network>-card.json to the current source.
// The OZ plugin validates storage-layout compatibility against .openzeppelin/ before sending anything.
// The signer must hold DEFAULT_ADMIN_ROLE (on mainnet that is the multisig: use proposeUpgrade instead).
const fs = require('node:fs');
const path = require('node:path');
const { ethers, upgrades, network } = require('hardhat');

async function main() {
  const file = path.resolve(__dirname, `../deployments/${network.name}-card.json`);
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const Card = await ethers.getContractFactory('OpenHypeCollectible');
  const before = await upgrades.erc1967.getImplementationAddress(report.proxy);
  const card = await upgrades.upgradeProxy(report.proxy, Card, { kind: 'uups', timeout: 120000 });
  await card.waitForDeployment();
  // Public X Layer RPC nodes lag each other: wait until reads see the new implementation.
  let after = before;
  for (let i = 0; i < 30 && after === before; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    after = await upgrades.erc1967.getImplementationAddress(report.proxy);
  }
  if (after === before) throw new Error('Implementation did not change; check the upgrade transaction');
  report.implementation = after;
  report.upgrades = [...(report.upgrades || []), { at: new Date().toISOString(), from: before, to: after }];
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  const domain = await card.eip712Domain();
  console.log(JSON.stringify({ proxy: report.proxy, from: before, to: after, eip712: { name: domain.name, version: domain.version } }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
