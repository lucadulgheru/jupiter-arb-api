import { Connection, Keypair, Transaction } from '@solana/web3.js'
import { Wallet } from '@project-serum/anchor'
import { TokenListProvider } from '@solana/spl-token-registry'
import axios from 'axios'
import bs58 from 'bs58'
import promiseRetry from 'promise-retry'

const GENESYS_RPC_ENDPOINT = 'https://ssc-dao.genesysgo.net';
const SERUM_RPC_ENDPOINT = 'https://solana-api.projectserum.com';
const QUICKNODE_RPC_ENDPOINT = 'https://misty-wispy-dawn.solana-mainnet.quiknode.pro/';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CONNECTION_COMMITMENT = 'processed';
const ENV = "mainnet-beta";
const HEADERS = {
	'Content-Type': 'application/json'
};

if (process.argv.length !== 6) {
	console.log('Script usage: node index.js <TOKEN> <AMOUNT> <SLIPPAGE> <DESIRED_PROFIT>');
	process.exit();
}

// Gathering preliminary data first (tokens, connection to RPC, wallet data)
const TOKEN_LIST = await new TokenListProvider().resolve().then((tokens) => {
	return tokens.filterByClusterSlug(ENV).getList();
});
//const connection = new Connection(GENESYS_RPC_ENDPOINT, CONNECTION_COMMITMENT);
//const connection = new Connection(QUICKNODE_RPC_ENDPOINT, CONNECTION_COMMITMENT);
const connection = new Connection(SERUM_RPC_ENDPOINT, CONNECTION_COMMITMENT);
const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY || '')));
const walletPublicKey = wallet.publicKey.toString();

const tokenSymbol = process.argv[2];
const amount = Number.parseInt(process.argv[3]);
const selectedToken = extractToken(tokenSymbol);

const SLIPPAGE = process.argv[4];
const AMOUNT = amountToLamports(selectedToken, amount).toString();
const COIN_MINT = selectedToken.address;
const DESIRED_PROFIT = Number.parseFloat(process.argv[5]);

const QUOTE_API = `https://quote-api.jup.ag/v1/quote?inputMint=${COIN_MINT}&outputMint=${COIN_MINT}&amount=${AMOUNT}&slippage=${SLIPPAGE}`
const SWAP_API = 'https://quote-api.jup.ag/v1/swap'


// Gathers all the routes for a given token depending on amount and slippage
async function getRoutes() {
	return await axios.get(QUOTE_API)
		.then((response) => {
			return response.data.data;
		});
}

// Builds transaction collection that we're going to send to the blockchain in order to get processed
async function buildTransactions(jupiterRoute) {
	return await axios.post(SWAP_API, JSON.stringify({
		route: jupiterRoute,
		userPublicKey: walletPublicKey,
		wrapUnwrapSOL: true
	}),
		{ headers: HEADERS }).then((response) => {
			return response.data;
		}
		);
}

// Converts our input amount to the corresponding Lamports value depending on token decimals
function amountToLamports(token, amount) {
	return token ? Math.round(amount * 10 ** token.decimals) : 0;
}

function lamportsToAmount(token, lamports) {
	return lamports / 10 ** token.decimals;
}

// Looks through the whole token registry and returns all the details of a given coin (address, decimals, etc.)
function extractToken(tokenSymbol) {
	const foundToken = TOKEN_LIST.find(function (item, i) {
		if (item.symbol === tokenSymbol) {
			return TOKEN_LIST[i];
		}
	});
	if (foundToken) {
		return foundToken;
	}
	else {
		throw Error('Could not find token ' + tokenSymbol);
	}
}

const getConfirmTransaction = async (txid) => {
	const res = await promiseRetry(
		async (retry, attempt) => {
			let txResult = await connection.getTransaction(txid, {
				commitment: "confirmed",
			});

			if (!txResult) {
				const error = new Error("Transaction was not confirmed");
				error.txid = txid;

				retry(error);
				return;
			}
			return txResult;
		},
		{
			retries: 40,
			minTimeout: 500,
			maxTimeout: 1000,
		}
	);
	if (res.meta.err) {
		throw new Error("Transaction failed");
	}
	return txid;
};

async function executeTransactions(transactionList) {
	for (let serializedTransaction of transactionList.filter(Boolean)) {
		const transaction = Transaction.from(Buffer.from(serializedTransaction, 'base64'))
		const txid = await connection.sendTransaction(transaction, [wallet.payer], {
			skipPreflight: true
		});
		try {
			await getConfirmTransaction(txid);
			console.log(`Transaction successful: https://solscan.io/tx/${txid}`);
		} catch (e) {
			// console.log(`Transaction failed: https://solscan.io/tx/${txid}`);
		}
	}
}

function calculateProfit(inputAmount, outputAmount) {
	// return (outputAmount - inputAmount >= (0.003 * inputAmount));
	return (outputAmount - inputAmount >= DESIRED_PROFIT);
}

while (1) {
	try {
//		const beforeRoutes = new Date();
		const routes = await getRoutes();
		const outAmount = lamportsToAmount(selectedToken, routes[0].outAmountWithSlippage);
		if (calculateProfit(amount, outAmount)) {
			const { setupTransaction, swapTransaction, cleanupTransaction } = await buildTransactions(routes[0]);
			await executeTransactions([setupTransaction, swapTransaction, cleanupTransaction]);
		}
//		console.log('After calculating profits: ' + (+new Date() - +beforeRoutes) / 1000.0 + ' seconds');
	} catch (e) {
//		console.log(e);
	}
}
