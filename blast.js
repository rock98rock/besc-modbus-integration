require('dotenv').config()
var fs = require("fs");
var CronJob = require('cron').CronJob;
var besc_client = require("besc-ess-nodejs-client");

var jsBeautify = require('js-beautify').js;

var configFile, config;

var keypair = new besc_client.keyPair(process.env.PROJECT_ID, process.env.APIKEY);

const ProjectData = besc_client.ProjectData;
const Device = besc_client.Device;

var host_client;
if(process.env.BESC_ESS_API_PATH){
    console.log("Using custom ESS API URL");
    host_client = new besc_client.Host(process.env.BESC_ESS_API_PATH);
}
else{
    console.log("Using default ESS API URL");
    host_client = besc_client.Host.createDefault();
}

var ModbusRTU = require("modbus-serial");
var clients = {};
var client = {};

var fp = require('ieee-float');
var { evaluate, round } = require("mathjs");

console.error = function(d){

    var datetime = new Date().toLocaleString('en-GB');

    var formatedData = jsBeautify(`${datetime}:` + d);

    const data = new Uint8Array(Buffer.from("\n"+formatedData));

    fs.appendFileSync('./error.log', data);
}

var reconCount = 0;
var currentPoll = {};

function saveLog(savingText){

    var datetime = new Date().toLocaleString('en-GB');

    var formatedData = jsBeautify(`${datetime}:` + savingText);

    const data = new Uint8Array(Buffer.from("\n"+formatedData));

    fs.appendFileSync('./logs.log', data);
}

const reConnection = async(doCount = true)=>{

    if(reconCount === 3){
        throw 'Reconnection count reached.';
    }

    if(doCount){
        reconCount++;
    }

    if(client && client.isOpen){
        saveLog("Reconnecting now");
        client.close();

        await createConnection(currentPoll);
    }

    return true;
}

const getReading = async (polls) => {

    reconCount = 0;

    var readings = [];

    for (var x = 0; x < polls.length; x++) {
        try {
            var poll = polls[x];

            currentPoll = poll;
            
            if(client && client.isOpen){
                client.close();
            }

            await createConnection(poll);

            /*
            if(Object.keys(clients).length > 0 ){ // && poll.type.toLowerCase() === "serial"
                //saveLog("Closing now");
                //client.close();    
                client = clients[x];
            }
            else{
                await createConnection(poll);

                if(poll.type.toLowerCase() === "serial"){
                    clients[x] = client;
                }
            }
            */

            //saveLog(client);

            var singlePollReading = await getDevicesReading(poll.Devices);    

            Array.prototype.push.apply(readings, singlePollReading);
            

            //saveLog(client.isOpen);

            
            if(client && client.isOpen){
                saveLog("Connection closed");
                client.close();
            }
            
        }
        catch (error) {
            saveLog(`Throw at getReading: ${error}`);
        }
    }

    return readings;
}

const createConnection = async (pollConfig) => {

    //var tempClient;

    try {

        client = await new ModbusRTU();

        if (pollConfig.type.toLowerCase() === "serial") {

            saveLog("\nConnecting with Serial");

            var serialOptions = {
                baudRate: pollConfig.baudRate,
                dataBits: pollConfig.dataBits,
                stopBits: pollConfig.stopBits,
                parity: pollConfig.parity
            };

            if (pollConfig.protocol.toLowerCase() === "rtu") {
                await client.connectRTUBuffered(pollConfig.port, serialOptions);
            }
            else if (pollConfig.protocol.toLowerCase() === "ascii") {
                await client.connectAsciiSerial(pollConfig.port, serialOptions);
            }
            else {
                throw 'Invalid protocol type found';
            }
        }
        else if (pollConfig.type.toLowerCase() === "tcp") {
            saveLog("\nConnecting with TCP");
            await client.connectTcpRTUBuffered(pollConfig.host, { port: pollConfig.port });
        }
        else {
            throw 'Invalid poll type found';
        }

        client.setTimeout(5000);

        //saveLog(client);

        //return tempClient;
        return true;

    } catch (error) {
        //if(tempClient && tempClient.isOpen){
        //tempClient.close();
        //}

        if(reconCount === 3){
            saveLog(`Throw at createConnection: ${error}`);
            throw error;
        }
        else{
            reconCount++;

            if (client && client.isOpen) {
                client.close();
            }

            createConnection(pollConfig);
        }
    }
}

const getDevicesReading = async (devices) => {

    var singlePollReading = [];

    for (var x = 0; x < devices.length; x++) {

        try {

            /*
            if(x > 0 && currentPoll.type.toLowerCase() === "serial"){
                await reConnection(false);
            }
            */

            var device = devices[x];

            var totalReadingBit = device.registerLength * device.registerBit;

            if (totalReadingBit > 64) {
                throw 'Total Register Bit cannot be more than 64 bit ';
            }

            //saveLog(client);

            var fetchedReading = await getMeterValue(device.deviceNum, device.registerLength, device.address, device.registerType);

            var meterValue;

            if (device.dataType.toLowerCase() === "int") {

                switch (totalReadingBit) {
                    case 16:
                        if (device.endian.toLowerCase() === "le") {
                            meterValue = fetchedReading.buffer.readIntLE(0, 2);
                        }
                        else if (device.endian.toLowerCase() === "be") {
                            meterValue = fetchedReading.buffer.readIntBE(0, 2);
                        }

                        break;
                    case 32:
                        if (device.endian.toLowerCase() === "le") {
                            meterValue = fetchedReading.buffer.readIntLE(0, 4);
                        }
                        else if (device.endian.toLowerCase() === "be") {
                            meterValue = fetchedReading.buffer.readIntBE(0, 4);
                        }

                        break;
                    case 64:
                        throw '64bit reading currently not supported';
                        break;

                    default:
                        throw 'Invalid bit reading found.' + totalReadingBit;
                        break;
                }
            }
            else if (device.dataType.toLowerCase() === "floating_point") {
                var bufferCp = Buffer.from(fetchedReading.buffer);

                var swapped16 = bufferCp.swap16();

                var value = new Uint32Array(swapped16);

                var val;

                if (device.endian.toLowerCase() === "be") {
                    val = fp.readFloatLE(value);
                }
                else if (device.endian.toLowerCase() === "le") {
                    val = fp.readFloatBE(value);
                }
                else {
                    throw 'Invalid endian found';
                }

                meterValue = round(val, 3);
            }
            else if (device.dataType.toLowerCase() === "float") {

                var floatValue;

                if (device.endian.toLowerCase() === "be") {
                    floatValue = fetchedReading.buffer.readFloatBE(0);
                }
                else if (device.endian.toLowerCase() === "le") {
                    floatValue = fetchedReading.buffer.readFloatLE(0);
                }

                meterValue = round(floatValue, 3);
            }
            else {
                throw {name:"INVALID TYPE", error:'Invalid dataType found'};
            }

            if (device.mod) {

                var obj = { reading: meterValue };

                meterValue = evaluate(device.mod, obj);
            }

            var meterReading = { name: device.name, energy: meterValue };

            singlePollReading.push(meterReading);

            await sleep(100);

        } catch (error) {
            saveLog(`Throw at getDevicesReading: ` + JSON.stringify(error));
            saveLog(error);
            
            if(error.name === "TransactionTimedOutError"){
                try {
                    await reConnection();
                    return getDevicesReading(devices);  
                } catch (error) {
                    throw error;
                }
            }
            else if(error.name === "PortNotOpenError"){
                throw error;
            }
        }
    }

    return singlePollReading;
}

const getMeterValue = async (id, length, registerAddress, registerType) => {
    try {
        await client.setID(id);

        var val;

        if (registerType == 3) {
            val = await client.readHoldingRegisters(registerAddress - 1, length);
        }
        else if (registerType == 4) {
            val = await client.readInputRegisters(registerAddress - 1, length);
        }
        else {
            throw 'Invalid registerType'
        }

        // val.data[0]

        return val;
    } catch (e) {
        throw e;
    }
}

const calculateEnergy = async (devicesReading) => {

    var newReading = [];
    var oldReading = [];

    if (fs.existsSync("./deviceData.json")) {

        try {
            var previousReading;

            var deviceData = fs.readFileSync("./deviceData.json");
            previousReading = JSON.parse(deviceData);

            oldReading = previousReading.Devices;

            var previousReadingObj = oldReading.reduce((map, obj) => (map[obj.name] = obj.energy, map), {});

            for (var x = 0; x < devicesReading.length; x++) {

                var deviceReading = { name: devicesReading[x].name, energy: devicesReading[x].energy };

                if (previousReadingObj[deviceReading.name]) {

                    var prevEnergy = previousReadingObj[deviceReading.name];

                    deviceReading.energy = deviceReading.energy - prevEnergy;

                    if (deviceReading.energy < 0) {
                        deviceReading.energy = 0;
                    }

                    newReading.push(deviceReading);
                }
                else {
                    newReading.push(deviceReading);
                }
            }

            var newReadingObj = newReading.reduce((map, obj) => (map[obj.name] = obj.energy, map), {});

            for (let deviceName in previousReadingObj) {
                if (typeof newReadingObj[deviceName] === "undefined") {
                    devicesReading.push({ name: deviceName, energy: previousReadingObj[deviceName] });
                }
            }

        } catch (error) {
            saveLog(error);
            newReading = devicesReading;
        }
    }
    else {
        newReading = devicesReading;
    }

    var formatedData = jsBeautify(JSON.stringify({ "Devices": devicesReading }));

    const data = new Uint8Array(Buffer.from(formatedData));

    fs.writeFileSync('./deviceData.json', data);

    return newReading;
}

const sendData = async (devicesReading) => {

    var reading = [];
    var totalEnergy = 0;

    for (var x = 0; x < devicesReading.length; x++) {

        var deviceReading = devicesReading[x];

        reading.push(new Device(deviceReading.name, deviceReading.energy));
        totalEnergy += deviceReading.energy;
    }

    var projectData = ProjectData.creatWithCurrentTime(
        config.ProjectName,
        reading,
        totalEnergy,
        config.AverageRT,
        config.Location
    );

    try {
        var response = await besc_client.API.sendProjectData(host_client, keypair, projectData);

        return response;
    }
    catch (apiError) {
        saveLog(`Throw at sendData: ${apiError}`);
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

if(process.env.REPEAT_EVERY_MINUTES != parseInt(process.env.REPEAT_EVERY_MINUTES)){
    console.log("Trigger minutes must be integer");
    process.exit();
}

var job = new CronJob(`*/${process.env.REPEAT_EVERY_MINUTES} * * * *`, async function () {

    try {

        try {
            configFile = fs.readFileSync("./config.json");

            config = JSON.parse(configFile);

        } catch (error) {
            console.error(error);
            process.exit();
        }

        var devicesReading = await getReading(config.Polls);

        saveLog("\nDevices Reading:");
        saveLog(devicesReading);

        var energyReading = await calculateEnergy(devicesReading);

        saveLog("\nCalculated Reading:");
        saveLog(energyReading);

		if(!process.env.DISABLE_DATA_SEND){
			var response = await sendData(energyReading);

			saveLog("\nESS API Response:");
			saveLog(response);
		}
        
    } catch (error) {
        saveLog(`Throw at cronjob: ${error}`);
    }

    //job.stop();

}, null, false, 'UTC');


job.start();
