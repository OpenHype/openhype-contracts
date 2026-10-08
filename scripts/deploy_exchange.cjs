// Deploys the OpenHypeExchange UUPS proxy for the collection recorded in deployments/<network>-card.json.
// The deployer only pays gas: every role and address comes from the environment, and the deployer keeps
// no role unless it is explicitly the admin. Resumable: an existing report is verified, never redeployed.
//
//   EXCHANGE_ADMIN_ADDRESS, EXCHANGE_OPERATOR_ADDRESS, EXCHANGE_TAKER_ADDRESS,
//   EXCHANGE_INVENTORY_ADDRESS, EXCHANGE_PROCEEDS_ADDRESS,
//   EXCHANGE_CURRENCIES (comma-separated token addresses),
//   EXCHANGE_TAKER_MAX_PER_FILL, EXCHANGE_TAKER_MAX_PER_WINDOW (whole token units, e.g. 1000 and 1500),
//   EXCHANGE_TAKER_WINDOW_SECONDS (default 3600).
//
// The collection must then grant the exchange MINTER_ROLE and OPERATOR_ROLE. GRANT_COLLECTION_ROLES=yes
// does it here when the signer holds the collection's admin role on testnet; otherwise the calls to make
// are printed. Mainnet (network xlayer) runs lib/mainnet_guard.cjs first and needs CONFIRM_MAINNET=yes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ethers, upgrades, network } = require('hardhat');
const { defaultTestnetAddresses, exchangeMainnetProblems } = require('../lib/mainnet_guard.cjs');

const CHAINS = { xlayerTestnet: 1952n, xlayer: 196n };
const MAINNET = 196n;
const ERC20 = ['function decimals() view returns (uint8)'];

async function main() {
  const chainId = CHAINS[network.name];
  if (!chainId || (await ethers.provider.getNetwork()).chainId !== chainId)
    throw new Error(`Unsupported network ${network.name}`);
  const [deployer] = await ethers.getSigners();
  const deployments = path.resolve(__dirname, '../deployments');
  const card = JSON.parse(fs.readFileSync(path.join(deployments, `${network.name}-card.json`), 'utf8'));
  const file = path.join(deployments, `${network.name}-exchange.json`);
  const Exchange = await ethers.getContractFactory('OpenHypeExchange');
  await upgrades.validateImplementation(Exchange, { kind: 'uups' });

  let report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (!report) {
    const plan = await readPlan(card.proxy);
    console.log(JSON.stringify({ chainId: Number(chainId), deployer: deployer.address, ...plan }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    if (chainId === MAINNET) {
      const problems = exchangeMainnetProblems({
        deployer: deployer.address,
        ...plan,
        adminCode: await ethers.provider.getCode(plan.admin),
        testnet: defaultTestnetAddresses(path.resolve(__dirname, '..')),
        allowEoaAdmin: process.env.ALLOW_EOA_ADMIN === 'yes',
        allowDeployerAdmin: process.env.ALLOW_DEPLOYER_ADMIN === 'yes',
      });
      if (problems.length) throw new Error(`Refusing the mainnet deployment:\n- ${problems.join('\n- ')}`);
      if (process.env.CONFIRM_MAINNET !== 'yes')
        throw new Error('Mainnet plan above passed the checks. Re-run with CONFIRM_MAINNET=yes to deploy.');
    }
    const exchange = await upgrades.deployProxy(
      Exchange,
      [plan.admin, plan.operator, plan.taker, plan.config],
      { kind: 'uups', timeout: 120000 },
    );
    report = {
      chainId: Number(chainId),
      proxy: await exchange.getAddress(),
      deployTx: exchange.deploymentTransaction().hash,
      deployer: deployer.address,
      admin: plan.admin,
      operator: plan.operator,
      taker: plan.taker,
      collection: plan.config.collection,
      inventory: plan.config.inventory,
      proceedsRecipient: plan.config.proceedsRecipient,
      currencies: plan.config.currencies,
      takerLimits: plan.config.currencies.map((currency, i) => ({
        currency,
        maxPerFill: plan.config.takerMaxPerFill[i].toString(),
        maxPerWindow: plan.config.takerMaxPerWindow[i].toString(),
        window: Number(plan.config.takerWindow),
      })),
    };
    // Journal the proxy before waiting, so an interrupted run can reattach instead of redeploying.
    save(file, report);
    await exchange.waitForDeployment();
  }

  if (!report.implementation) {
    report.implementation = await readImplementation(report.proxy);
    save(file, report);
  }

  const exchange = Exchange.attach(report.proxy);
  assert.equal(await exchange.hasRole(await exchange.DEFAULT_ADMIN_ROLE(), report.admin), true, 'admin role');
  assert.equal(await exchange.hasRole(await exchange.OPERATOR_ROLE(), report.operator), true, 'operator role');
  assert.equal(await exchange.hasRole(await exchange.TAKER_ROLE(), report.taker), true, 'taker role');
  if (deployer.address !== report.admin)
    assert.equal(await exchange.hasRole(await exchange.DEFAULT_ADMIN_ROLE(), deployer.address), false, 'deployer holds no role');
  assert.equal(await exchange.collection(), report.collection, 'collection');
  assert.equal(await exchange.inventory(), report.inventory, 'inventory');
  assert.equal(await exchange.proceedsRecipient(), report.proceedsRecipient, 'proceeds recipient');
  for (const currency of report.currencies) assert.equal(await exchange.isCurrencyAllowed(currency), true, currency);
  assert.equal(await exchange.paused(), false);

  await collectionRoles(report, deployer, chainId);
  console.log(JSON.stringify(report, null, 2));
}

async function readPlan(collection) {
  const address = name => ethers.getAddress(requireEnv(name));
  const admin = address('EXCHANGE_ADMIN_ADDRESS');
  const operator = address('EXCHANGE_OPERATOR_ADDRESS');
  const taker = address('EXCHANGE_TAKER_ADDRESS');
  const inventory = address('EXCHANGE_INVENTORY_ADDRESS');
  const proceedsRecipient = address('EXCHANGE_PROCEEDS_ADDRESS');
  if (operator === taker) throw new Error('Operator and taker must be different keys');
  if ([operator, taker].includes(admin)) throw new Error('The admin must hold neither the operator nor the taker role');
  const currencies = requireEnv('EXCHANGE_CURRENCIES').split(',').map(s => ethers.getAddress(s.trim().toLowerCase()));
  const units = async (currency, name) => {
    const decimals = await new ethers.Contract(currency, ERC20, ethers.provider).decimals();
    return ethers.parseUnits(requireEnv(name), decimals);
  };
  const takerMaxPerFill = [];
  const takerMaxPerWindow = [];
  for (const currency of currencies) {
    takerMaxPerFill.push(await units(currency, 'EXCHANGE_TAKER_MAX_PER_FILL'));
    takerMaxPerWindow.push(await units(currency, 'EXCHANGE_TAKER_MAX_PER_WINDOW'));
  }
  return {
    admin,
    operator,
    taker,
    inventory,
    proceedsRecipient,
    config: {
      collection,
      inventory,
      proceedsRecipient,
      currencies,
      takerMaxPerFill,
      takerMaxPerWindow,
      takerWindow: BigInt(process.env.EXCHANGE_TAKER_WINDOW_SECONDS || 3600),
    },
  };
}

/** Grants the exchange its collection roles on testnet when asked and allowed; reports what is missing. */
async function collectionRoles(report, signer, chainId) {
  const card = await ethers.getContractAt('OpenHypeCollectible', report.collection);
  const roles = { MINTER_ROLE: await card.MINTER_ROLE(), OPERATOR_ROLE: await card.OPERATOR_ROLE() };
  const missing = [];
  for (const [name, role] of Object.entries(roles)) if (!(await card.hasRole(role, report.proxy))) missing.push([name, role]);
  if (!missing.length) return console.log(JSON.stringify({ collectionRoles: 'granted' }));
  const canGrant = chainId !== MAINNET && (await card.hasRole(await card.DEFAULT_ADMIN_ROLE(), signer.address));
  if (process.env.GRANT_COLLECTION_ROLES === 'yes' && canGrant) {
    for (const [name, role] of missing) {
      await (await card.grantRole(role, report.proxy)).wait();
      console.log(JSON.stringify({ granted: name, to: report.proxy }));
    }
    return;
  }
  console.log(JSON.stringify({
    collectionRolesMissing: missing.map(([name]) => name),
    callsForCollectionAdmin: missing.map(([, role]) => ({ to: report.collection, data: card.interface.encodeFunctionData('grantRole', [role, report.proxy]) })),
  }, null, 2));
}

async function readImplementation(proxy) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await upgrades.erc1967.getImplementationAddress(proxy);
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
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
