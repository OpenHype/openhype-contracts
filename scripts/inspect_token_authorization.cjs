// Read-only EIP-3009 capability check. Ephemeral test wallets are never funded or persisted.
// Run before enabling any payment_asset and periodically afterwards.
const { inspect } = require("../lib/token_authorization.cjs");
async function main() {
  const chainId = Number(process.argv[2]),
    url = process.argv[3],
    addresses = process.argv.slice(4);
  if (
    ![196, 1952].includes(chainId) ||
    !url ||
    new URL(url).protocol !== "https:" ||
    !addresses.length
  )
    throw new Error(
      "Usage: node scripts/inspect_token_authorization.cjs <196|1952> <https-rpc> <token>...",
    );
  const rpc = async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("RPC HTTP " + response.status);
    const body = await response.json();
    if (body.error) {
      const error = new Error(JSON.stringify(body.error));
      error.executionReverted =
        body.error.code === 3 ||
        /execution reverted/i.test(body.error.message || "");
      error.data = typeof body.error.data === "string" ? body.error.data : undefined;
      throw error;
    }
    if (body.id !== 1 || body.result === undefined)
      throw new Error("Invalid RPC response");
    return body.result;
  };
  const results = [];
  for (const address of addresses) {
    try {
      results.push(await inspect(rpc, chainId, address));
    } catch (error) {
      results.push({
        chainId,
        address,
        status: "unverified",
        reason: error.message,
      });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some((row) => row.status !== "eip3009_simulated"))
    process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
