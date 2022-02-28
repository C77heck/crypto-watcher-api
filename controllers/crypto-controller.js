const HttpError = require('../models/http-error');
const Price = require('../models/prices');
const Purchase = require('../models/purchase');
const {numArray} = require("./libs/helpers");
const {Fluctuation} = require("./libs/fluctuation");
const {latestListings, newListings, allCryptos} = require("../libs/api-helper");
const {get, set} = require('../libs/redis-client');
const {json, removeDuplicates} = require('../libs/helpers');
const {terminal} = require("../libs/terminal-helper");
const {
    CONSTANTS: {
        CRYPTOS_TO_FOLLOW,
        CRYPTOS_FOR_SELECT,
        CRYPTO_FLUCTUATION,
        CRYPTO_PAGINATION,
        CURRENCY,
        TRANSACTION_FEE
    }
} = require('../libs/constants');
const {handleError} = require("../libs/error-handler");

const getLatestListings = async (req, res, next) => {
    handleError(req, next);
    //await clearPriceDB();
    const listings = await latestListings();

    if (!!listings.status && !listings.status.error_code) {
        await savePrices(listings?.data || [], listings?.status?.timestamp || new Date());
        await saveAssets((listings?.data || []));
        await saveFluctuationAsPaginated((listings?.data || []));
    }

    res.json({listings})
}

const saveAssets = async (data) => {
    const assets = data.map(crypto => ({
        name: crypto.name,
        symbol: crypto.symbol,
        id: crypto.id,
        price: crypto?.quote[CURRENCY]?.price || 0,
    }));

    await set(CRYPTOS_FOR_SELECT, json(assets));
}

const saveFluctuationAsPaginated = async (data) => {
    const paginationLength = numArray(Math.round(data.length / 100) || 1);
    const pages = [];
    for (const page of paginationLength) {
        const pageId = `${CRYPTO_FLUCTUATION}-${page}`;
        pages.push(pageId);
        await set(pageId, json(formatFluctuation(data, page)));
    }

    await set(CRYPTO_PAGINATION, json(pages));

}

const formatFluctuation = (prices, page) => {
    console.log(prices.slice(page - 1, page).length);
    return (prices.slice(page - 1, page) || []).map(price => new Fluctuation(price));
}

const clearPriceDB = async () => {
    try {
        await Price.remove({});
    } catch (e) {

    }
}

const getAssets = async (req, res, next) => {
    handleError(req, next);

    try {
        const assets = await get(CRYPTOS_FOR_SELECT);

        res.json({assets: !!assets ? json(assets) : []});
    } catch (e) {
        return next(new HttpError('Sorry, something went wrong.', 500));
    }

}

const savePrices = async (listings, date) => {
    for (const listing of listings) {
        try {
            const {id, name, symbol, quote: {HUF}} = listing;

            const createdPrice = new Price({
                name, symbol,
                price: HUF.price,
                identifier: id,
                created_at: date,
                percentChangeLastHour: HUF.percent_change_1h,
                percentChangeLastDay: HUF.percent_change_24h,
                percentChangeLastWeek: HUF.percent_change_7d,
                percentChangeLastMonth: HUF.percent_change_30d,
                percentChangeLast60Days: HUF.percent_change_60d,
                percentChangeLast90Days: HUF.percent_change_90d,
            });

            await createdPrice.save();
        } catch (e) {
            console.log(e);
        }
    }
}

const startFollowing = async (req, res, next) => {
    handleError(req, next);

    try {
        const {cryptos} = req.body;
        const followedCryptos = json(await get(CRYPTOS_TO_FOLLOW), []);
        const combined = removeDuplicates([...(followedCryptos || []), ...cryptos]);
        await set(CRYPTOS_TO_FOLLOW, json(combined));

        res.json({combined, followedCryptos})
    } catch (e) {
        return next(new HttpError('Sorry, something went wrong.', 500));
    }
}

const stopFollowing = async (req, res, next) => {
    handleError(req, next);

    try {
        const {cryptos} = req.body;
        const followedCryptos = json(await get(CRYPTOS_TO_FOLLOW), []);
        const filtered = (followedCryptos || []).filter(item => !cryptos.includes(item))
        await set(CRYPTOS_TO_FOLLOW, json(filtered));

        res.json({filtered})
    } catch (e) {
        return next(new HttpError('Sorry, something went wrong.', 500));
    }
}

const addNewPurchase = async (req, res, next) => {
    handleError(req, next);

    const {name, symbol, price, amount, thresholds, identifier} = req.body;
    try {
        const createdPurchase = new Purchase({identifier, name, symbol, price, amount, thresholds, date: new Date()});
        await createdPurchase.save();
    } catch (e) {
        return next(new HttpError(`'Sorry, something went wrong.'${e}`, 500));
    }

    try {
        const followedCryptos = json(await get(CRYPTOS_TO_FOLLOW), []);
        const combined = removeDuplicates([...(followedCryptos || []), name]);
        await set(CRYPTOS_TO_FOLLOW, json(combined));
    } catch (e) {
        return next(new HttpError(`'Sorry, something went wrong.'${e}`, 500));
    }

    res.json({message: 'New purchase has been successfully added to the watchlist'})
}

const updatePurchase = async (req, res, next) => {
    handleError(req, next);
    const {name, symbol, price, amount, thresholds, identifier} = req.body;
    try {
        const purchase = await Purchase.updateDocument(req.params.id, {
            name,
            symbol,
            price,
            amount,
            thresholds,
            identifier
        });
    } catch (e) {
        return next(new HttpError(`'Sorry, something went wrong.'${e}`, 500));
    }

    res.json({message: 'New purchase has been successfully updated'})
}

const deletePurchase = async (req, res, next) => {
    handleError(req, next);

    const {id} = req.params;
    if (!id) {
        return next(new HttpError('Missing id', 503))
    }
    try {
        await Purchase.deleteById(id);
    } catch (e) {
        return next(new HttpError('Could not delete purchase', 503))
    }

    res.json({message: 'Purchase has been successfully deleted.'})
}

const getNewListings = async (req, res, next) => {
    handleError(req, next);

    const newCryptos = await newListings();
    // TODO -> See what could we use this for.
    res.json({newCryptos})
}
const getAllCryptos = async (req, res, next) => {
    handleError(req, next);

    const full_list = await allCryptos();
    res.json({full_list})
}

const getPurcasedPrices = async (req, res, next) => {
    handleError(req, next);

    const purchasedCryptos = await Purchase.getAll();
    const data = [];

    if (!!purchasedCryptos && !!purchasedCryptos.length) {
        for (const item of purchasedCryptos) {
            const foundItems = await Price.getByIdentifier(item.identifier);
            const {first, second, third} = item.thresholds;
            const currentPrice = foundItems?.price * item.amount;
            const percentageDiff = ((currentPrice * TRANSACTION_FEE) / (item.price * TRANSACTION_FEE)) * 100;

            data.push({
                percentageDiff, ...item?._doc || {}, first, second, third, currentPrice,
                priceBoughtFor: item.price,
                potentialProfit: (currentPrice * TRANSACTION_FEE) - (item.price),
            });
        }
    }

    res.json({items: data})
}

const getShouldSell = async (req, res, next) => {
    handleError(req, next);

    const purchasedCryptos = await Purchase.getAll();
    const data = [];

    if (!!purchasedCryptos && !!purchasedCryptos.length) {
        for (const item of purchasedCryptos) {
            const foundItems = (await Price.getByIdentifier(item.identifier) || [])[0] || {};
            const {first, second, third} = item.thresholds;
            const currentPrice = foundItems.price * item.amount;
            const percentageDiff = ((currentPrice * TRANSACTION_FEE) / (item.price * TRANSACTION_FEE)) * 100;
            getThreshold(first > percentageDiff, 'first', item.name);
            getThreshold(second > percentageDiff, 'second', item.name);
            getThreshold(third > percentageDiff, 'third', item.name);

            data.push({
                percentageDiff, ...item?._doc || {}, first, second, third, currentPrice,
                priceBoughtFor: item.price,
                potentialProfit: (currentPrice * TRANSACTION_FEE) - (item.price * TRANSACTION_FEE),
            });
        }
    }

    res.json({items: data})
}

const getValueChanges = async (req, res, next) => {
    const {page} = req.params; // num
    const nextPage = `${CRYPTO_FLUCTUATION}-${page + 1}`;
    let data = [];

    try {
        CRYPTO_PAGINATION
        const pagination = await get(CRYPTO_PAGINATION);
        // we need to return the pagination when calling it first too.
        if (!pagination.includes(nextPage)) {
            throw new HttpError('There are no more pages found', 404);
        }

        data = [...(await get(nextPage))];
    } catch (e) {

        return next(new HttpError(`Something went wrong ${e}`, 500));
    }

    res.json({items: data})
}

const getThreshold = (isThresholdHit, level, cryptoName) => {
    if (isThresholdHit) {
        sendNotification(level, cryptoName);
    }

    return isThresholdHit;
}

const sendNotification = (level, cryptoName) => {
    terminal(`osascript -e 'display alert "SELLING ADVISE" message "${cryptoName} has reached ${level} level of threshold. consider selling"'`);
}

exports.getLatestListings = getLatestListings;
exports.getNewListings = getNewListings;
exports.getAllCryptos = getAllCryptos;
exports.startFollowing = startFollowing;
exports.stopFollowing = stopFollowing;
exports.getShouldSell = getShouldSell;
exports.addNewPurchase = addNewPurchase;
exports.updatePurchase = updatePurchase;
exports.getAssets = getAssets;
exports.deletePurchase = deletePurchase;
exports.getPurcasedPrices = getPurcasedPrices;
exports.getValueChanges = getValueChanges;
