/*
 *  Power BI Visualizations
 *
 *  Copyright (c) Microsoft Corporation
 *  All rights reserved.
 *  MIT License
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the ""Software""), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions:
 *
 *  The above copyright notice and this permission notice shall be included in
 *  all copies or substantial portions of the Software.
 *
 *  THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *  THE SOFTWARE.
 */
import powerbi from "powerbi-visuals-api";
import * as _ from "lodash";
import * as $ from "jquery";
import * as fetchJsonp from "fetch-jsonp-es6";

import IPromise = powerbi.IPromise;
import PrimitiveValue = powerbi.PrimitiveValue;

import {
    IGeocoder,
    IGeocodeResource,
    IGeocoderOptions,
    IGeocodeQuery,
    IGeocodeQueueItem,
    IGeocodeResult,
    IGeocodeBoundaryCoordinate,
    IGeocodeCoordinate,
    GeocodeOptions,
    ILocationDictionary
} from "./interfaces/geocoderInterfaces";
import {
    BingAddress,
    BingGeoboundary,
    BingLocation,
    BingGeocodeResponse,
    BingGeoboundaryResponse,
    BingGeoboundaryPrimitive
} from "../interfaces/bingInterfaces";

import { UrlUtils } from "../UrlUtils/UrlUtils";
import { BingSettings } from "../settings";
import { Http2ServerResponse } from "http2";

export const CategoryTypes = {
    Address: "Address",
    City: "City",
    Continent: "Continent",
    CountryRegion: "Country", // The text has to stay "Country" because it is used as a key in the geocoding caching dictionary
    County: "County",
    Longitude: "Longitude",
    Latitude: "Latitude",
    Place: "Place",
    PostalCode: "PostalCode",
    StateOrProvince: "StateOrProvince"
};

export enum JQueryPromiseState {
    pending,
    resolved,
    rejected,
}

export function createGeocoder(): IGeocoder {
    return new DefaultGeocoder();
}

export abstract class BingMapsGeocoder implements IGeocoder {

    protected abstract bingGeocodingUrl(): string;
    protected abstract bingSpatialDataUrl(): string;

    private contentType: string;
    private inputType: string;
    private coreKey: string;
    private key: string;

    private static jsonpCallbackObjectName = "powerbi";
    private static HttpStatuses = {
        OK: 200,
        CREATED: 201
    };
    private static JobStatuses = {
        COMPLETED: "Completed",
        ABORTED: "Aborted",
        PENDING: "Pending"
    }

    constructor() {
        this.contentType = "application/xml";
        this.inputType = "xml";
        this.coreKey = "Agc-qH1P_amkhHFyqOlKpuPw4IH2P0A5DyuSqy6XL00aFYAaulS3xg_m5ZPcv3Cc";
        this.key = BingSettings.BingKey;
    }

    private createXmlStringFromLocationQueries(queries: string[]): string {
        const xmlStart: string = `<?xml version="1.0" encoding="utf-8"?>  
            <GeocodeFeed xmlns="http://schemas.microsoft.com/search/local/2010/5/geocode">`;
        const xmlEnd: string = `</GeocodeFeed>`;

        let entities: string = '';
        for (let i = 0; i < queries.length; i++) {
            let entity: string = `
            <GeocodeEntity Id="${i + 1}" xmlns="http://schemas.microsoft.com/search/local/2010/5/geocode">  
                <GeocodeRequest Culture="en-US" Query="${queries[i]}" MaxResults="1">  
                </GeocodeRequest>  
            </GeocodeEntity>`;
            entities += entity;
        }

        const result: string = xmlStart + entities + xmlEnd;
        return result;
    }

    public async geocodeByDataFlow(queries: string[]): Promise<ILocationDictionary> {
        debugger;
        let xmlString = this.createXmlStringFromLocationQueries(queries);

        return new Promise<ILocationDictionary>((resolve, reject) => {
            this.createJob(xmlString)
                .then((response) => {
                    if (!response.ok || response.status != BingMapsGeocoder.HttpStatuses.CREATED) {
                        reject("Geocoder Job creation error");
                    }
                    //get ID from readable stream
                    response.json()
                        .then((body) => {
                            const jobID: string = body.resourceSets[0].resources[0].id;
                            //get job status
                            let taskStatus = BingMapsGeocoder.JobStatuses.PENDING;
                            this.monitorJobStatusJsonp(jobID)
                                .then((response: any) => {
                                    if (response.statusCode == BingMapsGeocoder.HttpStatuses.OK) {
                                        taskStatus = response.resourceSets[0].resources[0].status;
                                        if (taskStatus == BingMapsGeocoder.JobStatuses.COMPLETED) {
                                            // get the job result in xml
                                            this.getJobResultJsonp(jobID)
                                                .then((response: any) => {
                                                    const locationDictionary: ILocationDictionary = this.parseXmlJobResult(response);
                                                    resolve(locationDictionary);
                                                })
                                                .catch(() => reject("Geocoder Job Result request has been failed"))
                                        }

                                        if (taskStatus == BingMapsGeocoder.JobStatuses.ABORTED) {
                                            reject("Geocoder job was aborted due to an error");
                                        }
                                    }
                                })
                                .catch(() => reject("Geocoder Job status request has been failed"));
                        })
                        .catch(() => reject("Geocoder API response has been changed"));
                })
                .catch((err) => reject("Geocoder error"));
        });
    }

    public geocode(geocodeParams: IGeocoderOptions): Promise<IGeocodeCoordinate> {
        return this.geocodeCore("geocode", new GeocodeQuery(this.bingGeocodingUrl(), this.bingSpatialDataUrl(), geocodeParams.query, geocodeParams.category), geocodeParams.options);
    }

    public geocodeBoundary(latitude: number, longitude: number, category: string = '', levelOfDetail: number = 2, maxGeoData: number = 3, options?: GeocodeOptions): Promise<IGeocodeBoundaryCoordinate | IGeocodeCoordinate> {
        return this.geocodeCore("geocodeBoundary", new GeocodeBoundaryQuery(this.bingGeocodingUrl(), this.bingSpatialDataUrl(), latitude, longitude, category, levelOfDetail, maxGeoData), options);
    }

    public geocodePoint(latitude: number, longitude: number, entities: string[], options?: GeocodeOptions): Promise<IGeocodeCoordinate | IGeocodeResource> {
        return this.geocodeCore("geocodePoint", new GeocodePointQuery(this.bingGeocodingUrl(), this.bingSpatialDataUrl(), latitude, longitude, entities), options);
    }

    private async createJob(xmlInput): Promise<Response> {
        const queryString = `input=${this.inputType}&key=${this.key}`;
        const url = `https://spatial.virtualearth.net/REST/v1/dataflows/geocode?${queryString}`;

        // output - json as default; xml
        return fetch(url,
            {
                headers: {
                    'Accept': this.contentType,
                    'Content-Type': this.contentType
                },
                method: "POST",
                body: xmlInput
            })
    }

    private async monitorJobStatusFetch(jobID: string): Promise<Response> {
        const queryString = `output=json&key=${this.key}`;
        const url = `https://spatial.virtualearth.net/REST/v1/Dataflows/Geocode/${jobID}?${queryString}`;

        // output - json as default; xml
        return fetch(url,
            {
                mode: 'no-cors',
                headers: new Headers([
                    ['Access-Control-Allow-Origin', '*'],
                    ['Access-Control-Allow-Headers', 'Content-Type'],
                    ['access-control-allow-methods', 'GET'],
                    ['content-type', "application/json; charset=UTF-8"],
                ]),
                method: "GET"
            })
    }

    private async getJobResult(jobID): Promise<Response> {
        const queryString = `key=${this.key}`;
        const url = `https://spatial.virtualearth.net/REST/v1/Dataflows/Geocode/${jobID}/output/succeeded/?${queryString}`;

        // output - json as default; xml
        return fetch(url,
            {
                mode: 'cors',
                headers: new Headers([
                    ['Access-Control-Allow-Origin', '*'],
                    ['Access-Control-Allow-Headers', 'Content-Type'],
                    ['access-control-allow-methods', 'GET'],
                    ['Accept', "application/json, text/*"]
                ]),
                method: "GET"
            })
    }

    private async getJobResultJsonp(jobID): Promise<Response> {
        const queryString = `key=${this.key}`;
        const url = `https://spatial.virtualearth.net/REST/v1/Dataflows/Geocode/${jobID}/output/succeeded/?${queryString}`;

        const callbackGuid: string = BingMapsGeocoder.generateCallbackGuid();

        // This is super dirty hack to bypass faked window object in order to use jsonp
        // We use jsonp because sandboxed iframe does not have an origin. This fact breaks regular AJAX queries.
        window[BingMapsGeocoder.jsonpCallbackObjectName][callbackGuid] = (data) => {
            delete window[BingMapsGeocoder.jsonpCallbackObjectName][callbackGuid];
        };

        // output - json as default; xml
        return $.ajax({
            url: url,
            dataType: 'xml',
            crossDomain: true,
            jsonp: "jsonp",
            jsonpCallback: `window.${BingMapsGeocoder.jsonpCallbackObjectName}.${callbackGuid}`
        }).promise()
    }

    private async monitorJobStatusJsonp(jobID: string): Promise<Response> {
        const queryString = `key=${this.key}`;
        const url = `https://spatial.virtualearth.net/REST/v1/Dataflows/Geocode/${jobID}?${queryString}`;

        const callbackGuid: string = BingMapsGeocoder.generateCallbackGuid();

        // This is super dirty hack to bypass faked window object in order to use jsonp
        // We use jsonp because sandboxed iframe does not have an origin. This fact breaks regular AJAX queries.
        window[BingMapsGeocoder.jsonpCallbackObjectName][callbackGuid] = (data) => {
            delete window[BingMapsGeocoder.jsonpCallbackObjectName][callbackGuid];
        };

        return $.ajax({
            url: url,
            dataType: 'json',
            crossDomain: true,
            jsonp: "jsonp",
            jsonpCallback: `window.${BingMapsGeocoder.jsonpCallbackObjectName}.${callbackGuid}`
        }).promise()
    }

    private static generateCallbackGuid(): string {
        let cryptoObj = window.crypto || window["msCrypto"]; // For IE
        const guidSequence: number = cryptoObj.getRandomValues(new Uint32Array(1))[0].toString(16).substring(0, 4);

        return `GeocodeCallback${guidSequence}${guidSequence}${guidSequence}`;
    }

    private parseXmlJobResult(xmlDocument: XMLDocument): ILocationDictionary {
        let result: ILocationDictionary = {};
        let entities = xmlDocument.getElementsByTagName("GeocodeEntity");
        for (let i = 0; i < entities.length; i++) {
            const currentEntity = entities[i];
            const geocodeRequest = currentEntity.getElementsByTagName("GeocodeRequest");
            const geocodeResponse = currentEntity.getElementsByTagName("GeocodeResponse");
            const query: string = geocodeRequest.item(0).getAttribute("Query");
            const statusCode: string = geocodeResponse.item(0).getAttribute("StatusCode");

            if (statusCode == "Success") {
                const longitude: number = Number(geocodeResponse[0].children[1].getAttribute("Longitude"));
                const latitude: number = Number(geocodeResponse[0].children[1].getAttribute("Latitude"));
                result[query] = {
                    latitude,
                    longitude
                }
            }
        }

        return result;
    }

    private geocodeCore(queueName: string, geocodeQuery: IGeocodeQuery, options?: GeocodeOptions): Promise<IGeocodeCoordinate> {
        debugger;

        let job = "32b70f685d334adfb1c438fb29f1f16c";
        this.monitorJobStatusJsonp(job)
            .then((response: any) => {
                if (response.statusCode == 200) {
                    let taskStatus = response.resourceSets[0].resources[0].status;
                    if (taskStatus == "Completed") {
                        // get the job result in xml
                        this.getJobResultJsonp(job)
                            .then((response: any) => {
                                // response is xml  document
                                debugger;

                            })
                            .catch(err => console.log(err))
                    }
                    else {
                        // if pending  - wait for 3000
                    }
                }

                debugger;
                console.log(response);
            })
            .catch(err => {
                debugger;
                console.log(err)
            });

        return Promise.resolve(null);
    }
}

export class DefaultGeocoder extends BingMapsGeocoder {
    protected bingSpatialDataUrl(): string {
        return 'https://platform.bing.com/geo/spatial/v1/public/Geodata';
    }

    protected bingGeocodingUrl(): string {
        return 'https://dev.virtualearth.net/REST/v1/Locations';
    }
}

export interface BingAjaxRequest {
    abort: () => void;
    always: (callback: () => void) => void;
    then: (successFn: (data: {}) => void, errorFn: (error: { statusText: string }) => void) => void;
}

export interface BingAjaxService {
    (url: string, settings: JQueryAjaxSettings): BingAjaxRequest;
}
export const safeCharacters: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Note: Used for test mockup */
// export let BingAjaxCall: BingAjaxService = $.ajax;
export const CategoryTypeArray = [
    "Address",
    "City",
    "Continent",
    "Country",
    "County",
    "Longitude",
    "Latitude",
    "Place",
    "PostalCode",
    "StateOrProvince"
];

export function isCategoryType(value: string): boolean {
    return CategoryTypeArray.indexOf(value) > -1;
}

export const BingEntities = {
    Continent: "Continent",
    Sovereign: "Sovereign",
    CountryRegion: "CountryRegion",
    AdminDivision1: "AdminDivision1",
    AdminDivision2: "AdminDivision2",
    PopulatedPlace: "PopulatedPlace",
    Postcode: "Postcode",
    Postcode1: "Postcode1",
    Neighborhood: "Neighborhood",
    Address: "Address",
};

// Static variables for caching, maps, etc.
let categoryToBingEntity: { [key: string]: string; };
let categoryToBingEntityGeodata: { [key: string]: string; };

export class GeocodeQueryBase {
    public query: string;
    public category: string;
    public key: string;

    protected bingSpatialDataUrl: string;
    protected bingGeocodingUrl: string;

    constructor(bingGeocodingUrl: string, bingSpatialDataUrl: string, query: string, category: string) {
        this.bingGeocodingUrl = bingGeocodingUrl;
        this.bingSpatialDataUrl = bingSpatialDataUrl;
        this.query = query != null ? !(/[<()>#@!$%&*\^`'"/+:]/).test(query) && !(/(javascript:|data:)/i).test(query) ? query : "" : "";
        this.category = category != null ? category : "";
        this.key = (`G:${this.bingGeocodingUrl}; S:${this.bingSpatialDataUrl};${this.query}/${this.category}`).toLowerCase();
    }

    public getKey(): string {
        return this.key;
    }
}

export class GeocodeQuery extends GeocodeQueryBase implements IGeocodeQuery {
    constructor(bingGeocodingUrl: string, bingSpatialDataUrl: string, query: string, category: string) {
        super(bingGeocodingUrl, bingSpatialDataUrl, query, category);
    }

    public getBingEntity(): string {
        let category: string = this.category.toLowerCase();
        if (!categoryToBingEntity) {
            categoryToBingEntity = {};
            categoryToBingEntity[CategoryTypes.Continent.toLowerCase()] = BingEntities.Continent;
            categoryToBingEntity[CategoryTypes.CountryRegion.toLowerCase()] = BingEntities.Sovereign;
            categoryToBingEntity[CategoryTypes.StateOrProvince.toLowerCase()] = BingEntities.AdminDivision1;
            categoryToBingEntity[CategoryTypes.County.toLowerCase()] = BingEntities.AdminDivision2;
            categoryToBingEntity[CategoryTypes.City.toLowerCase()] = BingEntities.PopulatedPlace;
            categoryToBingEntity[CategoryTypes.PostalCode.toLowerCase()] = BingEntities.Postcode;
            categoryToBingEntity[CategoryTypes.Address.toLowerCase()] = BingEntities.Address;
        }
        return categoryToBingEntity[category] || "";
    }

    public getUrl(): string {
        let parameters: _.Dictionary<string> = {
            key: BingSettings.BingKey,
        };

        let entityType: string = this.getBingEntity();
        let queryAdded: boolean = false;
        if (entityType) {
            if (entityType === BingEntities.Postcode) {
                parameters["includeEntityTypes"] = "Postcode,Postcode1,Postcode2,Postcode3,Postcode4";
            }
            else if (this.query.indexOf(",") === -1 && (entityType === BingEntities.AdminDivision1 || entityType === BingEntities.AdminDivision2)) {
                queryAdded = true;
                try {
                    parameters["adminDistrict"] = decodeURIComponent(this.query);
                } catch (e) {
                    return null;
                }
            }
            else {
                parameters["includeEntityTypes"] = entityType;

                if (this.query.length === 2 && entityType === BingEntities.Sovereign) {
                    queryAdded = true;
                    try {
                        parameters["countryRegion"] = decodeURIComponent(this.query);
                    } catch (e) {
                        return null;
                    }
                }
            }
        }

        if (!queryAdded) {
            try {
                parameters["q"] = decodeURIComponent(this.query);
            } catch (e) {
                return null;
            }
        }

        let cultureName: string = navigator["userLanguage"] || navigator["language"];
        cultureName = mapLocalesForBing(cultureName);
        if (cultureName) {
            parameters["c"] = cultureName;
        }
        parameters["maxRes"] = "20";
        // If the query is of length 2, request the ISO 2-letter country code to be returned with the result to be compared against the query so that such results can be preferred.
        if (this.query.length === 2 && this.category === CategoryTypes.CountryRegion) {
            parameters["include"] = "ciso2";
        }

        return UrlUtils.setQueryParameters(this.bingGeocodingUrl, parameters, /*keepExisting*/true);
    }

    public getResult(data: BingGeocodeResponse): IGeocodeResult {
        let location: BingLocation = getBestLocation(data, location => this.locationQuality(location));
        if (location) {
            let pointData: number[] = location.point.coordinates;
            let coordinates: IGeocodeCoordinate = {
                latitude: pointData && pointData[0],
                longitude: pointData && pointData[1]
            };

            return { coordinates: coordinates };
        }

        return { error: new Error("Geocode result is empty.") };
    }

    private locationQuality(location: BingLocation): number {
        let quality: number = 0;

        // two letter ISO country query is most important
        if (this.category === CategoryTypes.CountryRegion) {
            let iso2: string = location.address && location.address.countryRegionIso2;
            if (iso2) {
                let queryString: string = this.query.toLowerCase();
                if (queryString.length === 2 && queryString === iso2.toLowerCase()) {
                    quality += 2;
                }
            }
        }

        // matching the entity type is also important
        if (location.entityType && location.entityType.toLowerCase() === this.getBingEntity().toLowerCase()) {
            quality += 1;
        }

        return quality;
    }
}

// Double check this function
function getBestLocation(data: BingGeocodeResponse, quality: (location: BingLocation) => number): BingLocation {
    let resources: BingLocation[] = data && !_.isEmpty(data.resourceSets) && data.resourceSets[0].resources;
    if (Array.isArray(resources)) {
        let bestLocation = resources.map(location => ({ location: location, value: quality(location) }));

        return _.maxBy(bestLocation, (locationValue) => locationValue.value).location;
    }
}

export class GeocodePointQuery extends GeocodeQueryBase implements IGeocodeQuery {
    public latitude: number;
    public longitude: number;
    public entities: string[];

    constructor(bingGeocodingUrl: string, bingSpatialDataUrl: string, latitude: number, longitude: number, entities: string[]) {
        super(bingGeocodingUrl, bingSpatialDataUrl, [latitude, longitude].join(), "Point");
        this.latitude = latitude;
        this.longitude = longitude;
        this.entities = entities;
    }

    // Point queries are used for user real-time location data so do not cache
    public getKey(): string {
        return null;
    }

    public getUrl(): string {
        let urlAndQuery = UrlUtils.splitUrlAndQuery(this.bingGeocodingUrl);

        // add backlash if it's missing
        let url = !_.endsWith(urlAndQuery.baseUrl, '/') ? `${urlAndQuery.baseUrl}/` : urlAndQuery.baseUrl;

        url += [this.latitude, this.longitude].join();

        let parameters: _.Dictionary<string> = {
            key: BingSettings.BingKey,
            include: 'ciso2'
        };

        if (!_.isEmpty(this.entities)) {
            parameters['includeEntityTypes'] = this.entities.join();
        }

        return UrlUtils.setQueryParameters(url, parameters, /*keepExisting*/true);
    }

    public getResult(data: BingGeocodeResponse): IGeocodeResult {
        let location: BingLocation = getBestLocation(data, location => this.entities.indexOf(location.entityType) === -1 ? 0 : 1);
        if (location) {
            let pointData: number[] = location.point.coordinates;
            let addressData: BingAddress = location.address || {};
            let name: string = location.name;
            let coordinates: IGeocodeResource = {
                latitude: pointData[0],
                longitude: pointData[1],
                addressLine: addressData.addressLine,
                locality: addressData.locality,
                neighborhood: addressData.neighborhood,
                adminDistrict: addressData.adminDistrict,
                adminDistrict2: addressData.adminDistrict2,
                formattedAddress: addressData.formattedAddress,
                postalCode: addressData.postalCode,
                countryRegionIso2: addressData.countryRegionIso2,
                countryRegion: addressData.countryRegion,
                landmark: addressData.landmark,
                name: name,
            };
            return { coordinates: coordinates };
        }

        return { error: new Error("Geocode result is empty.") };
    }
}

export class GeocodeBoundaryQuery extends GeocodeQueryBase implements IGeocodeQuery {
    public latitude: number;
    public longitude: number;
    public levelOfDetail: number;
    public maxGeoData: number;

    constructor(bingGeocodingUrl: string, bingSpatialDataUrl: string, latitude: number, longitude: number, category: string, levelOfDetail: number, maxGeoData: number = 3) {
        super(bingGeocodingUrl, bingSpatialDataUrl, [latitude, longitude, levelOfDetail, maxGeoData].join(","), category);
        this.latitude = latitude;
        this.longitude = longitude;
        this.levelOfDetail = levelOfDetail;
        this.maxGeoData = maxGeoData;
    }

    public getBingEntity(): string {
        let category = this.category.toLowerCase();
        if (!categoryToBingEntityGeodata) {
            categoryToBingEntityGeodata = {};
            categoryToBingEntityGeodata[CategoryTypes.CountryRegion.toLowerCase()] = BingEntities.CountryRegion;
            categoryToBingEntityGeodata[CategoryTypes.StateOrProvince.toLowerCase()] = BingEntities.AdminDivision1;
            categoryToBingEntityGeodata[CategoryTypes.County.toLowerCase()] = BingEntities.AdminDivision2;
            categoryToBingEntityGeodata[CategoryTypes.City.toLowerCase()] = BingEntities.PopulatedPlace;
            categoryToBingEntityGeodata[CategoryTypes.PostalCode.toLowerCase()] = BingEntities.Postcode1;
        }
        return categoryToBingEntityGeodata[category] || "";
    }

    public getUrl(): string {
        let parameters: _.Dictionary<string> = {
            key: BingSettings.BingKey,
            $format: "json",
        };

        let entityType: string = this.getBingEntity();

        if (!entityType) {
            return null;
        }

        let cultureName: string = navigator["userLanguage"] || navigator["language"];
        cultureName = mapLocalesForBing(cultureName);
        let cultures: string[] = cultureName.split("-");
        let data: PrimitiveValue[] = [this.latitude, this.longitude, this.levelOfDetail, `'${entityType}'`, 1, 0, `'${cultureName}'`];
        if (cultures.length > 1) {
            data.push(`'${cultures[1]}'`);
        }
        parameters["SpatialFilter"] = `GetBoundary(${data.join(", ")})`;
        return UrlUtils.setQueryParameters(this.bingSpatialDataUrl, parameters, /*keepExisting*/true);
    }

    public getResult(data: BingGeoboundaryResponse): IGeocodeResult {
        let result: BingGeoboundaryResponse = data;
        if (result && result.d && Array.isArray(result.d.results) && result.d.results.length > 0) {
            let entity: BingGeoboundary = result.d.results[0];
            let primitives: BingGeoboundaryPrimitive[] = entity.Primitives;
            if (primitives && primitives.length > 0) {
                let coordinates: IGeocodeBoundaryCoordinate = {
                    latitude: this.latitude,
                    longitude: this.longitude,
                    locations: []
                };

                primitives.sort((a, b) => {
                    if (a.Shape.length < b.Shape.length) {
                        return 1;
                    }
                    if (a.Shape.length > b.Shape.length) {
                        return -1;
                    }
                    return 0;
                });

                let maxGeoData: number = Math.min(primitives.length, this.maxGeoData);

                for (let i = 0; i < maxGeoData; i++) {
                    let ringStr: string = primitives[i].Shape;
                    let ringArray: string[] = ringStr.split(",");

                    for (let j: number = 1; j < ringArray.length; j++) {
                        coordinates.locations.push({ nativeBing: ringArray[j] });
                    }
                }

                return { coordinates: coordinates };
            }
        }

        return { error: new Error("Geocode result is empty.") };
    }
}

/**
 * Map locales that cause failures to similar locales that work
 */
function mapLocalesForBing(locale: string): string {
    switch (locale.toLowerCase()) {
        case 'fr': // Bing gives a 404 error when this language code is used (fr is only obtained from Chrome).  Use fr-FR for a near-identical version that works. Defect # 255717 opened with Bing.
            return 'fr-FR';
        case 'de':
            return 'de-DE';
        default:
            return locale;
    }
}

namespace GeocodeQueueManager {
    let queues: _.Dictionary<GeocodeQueue> = {};

    function ensureQueue(queueName: string): GeocodeQueue {
        let queue: GeocodeQueue = queues[queueName];
        if (!queue) {
            queues[queueName] = queue = new GeocodeQueue();
        }
        return queue;
    }

    export function enqueue(queueName: string, item: IGeocodeQueueItem): void {
        ensureQueue(queueName).enqueue(item);
    }

    export function reset(): void {
        for (let queueName in queues) {
            queues[queueName].reset();
        }

        queues = {};
    }
}

interface GeocodeQueueEntry {
    item: IGeocodeQueueItem;
    request?: BingAjaxRequest;
    jsonp?: boolean;            // remember because JSONP requests can't be aborted
    isCompleted?: boolean;
}

export class GeocodeQueue {
    private callbackObjectName: string = "powerbi";

    private entries: GeocodeQueueEntry[] = [];
    private activeEntries: GeocodeQueueEntry[] = [];
    private dequeueTimeout: number;

    public reset(): void {
        let timeout: number = this.dequeueTimeout;
        if (timeout) {
            this.dequeueTimeout = undefined;
            clearTimeout(timeout);
        }

        for (let entry of this.entries.concat(this.activeEntries)) {
            this.cancel(entry);
        }

        this.entries = [];
        this.activeEntries = [];
    }

    public enqueue(item: IGeocodeQueueItem): void {
        let entry: GeocodeQueueEntry = { item: item };
        this.entries.push(entry);

        item.promise.finally(() => {
            this.cancel(entry);
        });

        this.dequeue();
    }

    private inDequeue = false;

    private dequeue(): void {
        if (this.inDequeue || this.dequeueTimeout) {
            return;
        }

        try {
            this.inDequeue = true;
            while (this.entries.length !== 0 && this.activeEntries.length < BingSettings.MaxBingRequest) {
                let entry = this.entries.shift();
                if (!entry.isCompleted) {  // !!!! Why?
                    this.makeRequest(entry);
                }
            }
        }
        finally {
            this.inDequeue = false;
        }
    }

    private scheduleDequeue(): void {
        if (!this.dequeueTimeout && this.entries.length !== 0) {
            this.dequeueTimeout = setTimeout(() => {
                this.dequeueTimeout = undefined;
                this.dequeue();
            });
        }
    }

    private cancel(entry: GeocodeQueueEntry): void {
        if (!entry.jsonp) {
            let request: BingAjaxRequest = entry.request;
            if (request) {
                entry.request = null;
                request.abort();
            }
        }

        this.complete(entry, { error: new Error('cancelled') });
    }

    private complete(entry: GeocodeQueueEntry, result: IGeocodeResult): void {
        if (!entry.isCompleted) {
            entry.isCompleted = true;

            if (entry.item.promise.pending()) {
                if (!result || !result.coordinates) {
                    entry.item.promise.reject(result && result.error || new Error('cancelled'));
                }
                else {
                    //entry.item.promise.resolve(result.coordinates); /// !!! logic
                }
            }
        }

        this.scheduleDequeue();
    }

    private makeJsonpAjaxQuery(entry: GeocodeQueueEntry): void {
        let guidSequence = () => {
            let cryptoObj = window.crypto || window["msCrypto"]; // For IE

            return cryptoObj.getRandomValues(new Uint32Array(1))[0].toString(16).substring(0, 4);
        };

        const callbackGuid: string = `GeocodeCallback${guidSequence()}${guidSequence()}${guidSequence()}`;

        // This is super dirty hack to bypass faked window object in order to use jsonp
        // We use jsonp because sandboxed iframe does not have an origin. This fact breaks regular AJAX queries.
        window[this.callbackObjectName][callbackGuid] = (data) => {
            if (entry.request) {
                entry.request.always(() => {
                    _.pull(this.activeEntries, entry);
                    entry.request = null;
                });
            }
            try {
                this.complete(entry, entry.item.query.getResult(data));
            }
            catch (error) {
                this.complete(entry, { error: error });
            }

            delete window[this.callbackObjectName][callbackGuid];
        };

        entry.jsonp = true;

        let url: string = entry.item.query.getUrl();

        if (!url) {
            this.complete(entry, { error: new Error("Unsupported query.") });
            return;
        }

        this.activeEntries.push(entry);

        //fetchJsop !

        entry.request = $.ajax({
            url: url,
            dataType: 'jsonp',
            crossDomain: true,
            jsonp: "jsonp",
            context: entry,
            jsonpCallback: `window.${this.callbackObjectName}.${callbackGuid}`
        });
    }

    private makeRequest(entry: GeocodeQueueEntry): void {
        if (entry.item.query["query"] === "") {
            this.cancel(entry);
            return;
        }

        this.makeJsonpAjaxQuery(entry);
    }
}
