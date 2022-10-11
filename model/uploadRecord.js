import { core } from "oicq"
import common from "oicq"
import Contactable from "oicq"
import querystring from "querystring"
import axios from "axios"
import fs from "fs"
import path from "path"
import errors from "oicq"
import os from "os"
import util from "util"
import stream from "stream"
import crypto from "crypto"
import child_process from "child_process"


async function uploadRecord(record_url, seconds = 0,transcoding = true) {
	const buf = await getPttBuffer(record_url, Bot.config.ffmpeg_path, transcoding);
	const hash = (0, md5)(buf);
    const codec = String(buf.slice(0, 7)).includes("SILK") ? (transcoding ? 1 : 0) : 0;
    const body = core.pb.encode({
		1: 3,
		2: 3,
		5: {
			1: Contactable.target,
			2: Bot.uin,
			3: 0,
			4: hash,
			5: buf.length,
			6: hash,
			7: 5,
			8: 9,
			9: 4,
			11: 0,
			10: Bot.apk.version,
			12: 1,
			13: 1,
			14: codec,
			15: 1,
		},
	});
	const payload = await Bot.sendUni("PttStore.GroupPttUp", body);
	const rsp = core.pb.decode(payload)[5];
	rsp[2] && (0, errors.drop)(rsp[2], rsp[3]);
	const ip = rsp[5]?.[0] || rsp[5], port = rsp[6]?.[0] || rsp[6];
	const ukey = rsp[7].toHex(), filekey = rsp[11].toHex();
	const params = {
		ver: 4679,
		ukey, filekey,
		filesize: buf.length,
		bmd5: hash.toString("hex"),
		mType: "pttDu",
		voice_encodec: codec
	};
	const url = `http://${(0, int32ip2str)(ip)}:${port}/?` + querystring.stringify(params);
	const headers = {
		"User-Agent": `QQ/${Bot.apk.version} CFNetwork/1126`,
		"Net-Type": "Wifi"
	};
	await axios.post(url, buf, { headers });
	const fid = rsp[11].toBuffer();
	const b = core.pb.encode({
		1: 4,
		2: Bot.uin,
		3: fid,
		4: hash,
		5: hash.toString("hex") + ".amr",
		11: 1,
		18: fid,
		19: seconds,
		30: Buffer.from([8, 0, 40, 0, 56, 0]),
	});
	return {
		type: "record", file: "protobuf://" + Buffer.from(b).toString("base64")
	};
}

export default uploadRecord

async function getPttBuffer(file, ffmpeg = "ffmpeg", transcoding = true) {
    if (file instanceof Buffer || file.startsWith("base64://")) {
        // Buffer或base64
        const buf = file instanceof Buffer ? file : Buffer.from(file.slice(9), "base64");
        const head = buf.slice(0, 7).toString();
        if (head.includes("SILK") || head.includes("AMR") || !transcoding) {
            return buf;
        }
        else {
            const tmpfile = path.join(TMP_DIR, (0, uuid)());
            await fs.promises.writeFile(tmpfile, buf);
            return audioTrans(tmpfile, ffmpeg);
        }
    }
    else if (file.startsWith("http://") || file.startsWith("https://")) {
        // 网络文件
        const readable = (await axios.get(file, { responseType: "stream" })).data;
        const tmpfile = path.join(TMP_DIR, (0, uuid)());
        await (0, pipeline)(readable.pipe(new DownloadTransform), fs.createWriteStream(tmpfile));
        const head = await read7Bytes(tmpfile);
        if (head.includes("SILK") || head.includes("AMR") || !transcoding) {
            const buf = await fs.promises.readFile(tmpfile);
            fs.unlink(tmpfile,NOOP);
            return buf;
        }
        else {
            return audioTrans(tmpfile, ffmpeg);
        }
    }
    else {
        // 本地文件
        file = String(file).replace(/^file:\/{2}/, "");
        IS_WIN && file.startsWith("/") && (file = file.slice(1));
        const head = await read7Bytes(file);
        if (head.includes("SILK") || head.includes("AMR") || !transcoding) {
            return fs.promises.readFile(file);
        }
        else {
            return audioTrans(file, ffmpeg);
        }
    }
}

function audioTrans(file, ffmpeg = "ffmpeg") {
    return new Promise((resolve, reject) => {
        const tmpfile = path.join(TMP_DIR, (0, uuid)());
        (0, child_process.exec)(`${ffmpeg} -y -i "${file}" -ac 1 -ar 8000 -f amr "${tmpfile}"`, async (error, stdout, stderr) => {
            try {
                const amr = await fs.promises.readFile(tmpfile);
                resolve(amr);
            }
            catch {
                reject(new core.ApiRejection(errors.ErrorCode.FFmpegPttTransError, "音频转码到amr失败，请确认你的ffmpeg可以处理此转换"));
            }
            finally {
                fs.unlink(tmpfile, NOOP);
            }
        });
    });
}

async function read7Bytes(file) {
    const fd = await fs.promises.open(file, "r");
    const buf = (await fd.read(Buffer.alloc(7), 0, 7, 0)).buffer;
    fd.close();
    return buf;
}

function uuid() {
    let hex = crypto.randomBytes(16).toString("hex");
    return hex.substr(0, 8) + "-" + hex.substr(8, 4) + "-" + hex.substr(12, 4) + "-" + hex.substr(16, 4) + "-" + hex.substr(20);
}

/** 计算流的md5 */
function md5Stream(readable) {
    return new Promise((resolve, reject) => {
        readable.on("error", reject);
        readable.pipe(crypto.createHash("md5")
            .on("error", reject)
            .on("data", resolve));
    });
}

/** 计算文件的md5和sha */
function fileHash(filepath) {
    const readable = fs.createReadStream(filepath);
    const sha = new Promise((resolve, reject) => {
        readable.on("error", reject);
        readable.pipe(crypto.createHash("sha1")
            .on("error", reject)
            .on("data", resolve));
    });
    return Promise.all([md5Stream(readable), sha]);
}

/** 群号转uin */
function code2uin(code) {
    let left = Math.floor(code / 1000000);
    if (left >= 0 && left <= 10)
        left += 202;
    else if (left >= 11 && left <= 19)
        left += 469;
    else if (left >= 20 && left <= 66)
        left += 2080;
    else if (left >= 67 && left <= 156)
        left += 1943;
    else if (left >= 157 && left <= 209)
        left += 1990;
    else if (left >= 210 && left <= 309)
        left += 3890;
    else if (left >= 310 && left <= 335)
        left += 3490;
    else if (left >= 336 && left <= 386)
        left += 2265;
    else if (left >= 387 && left <= 499)
        left += 3490;
    return left * 1000000 + code % 1000000;
}

/** uin转群号 */
function uin2code(uin) {
    let left = Math.floor(uin / 1000000);
    if (left >= 202 && left <= 212)
        left -= 202;
    else if (left >= 480 && left <= 488)
        left -= 469;
    else if (left >= 2100 && left <= 2146)
        left -= 2080;
    else if (left >= 2010 && left <= 2099)
        left -= 1943;
    else if (left >= 2147 && left <= 2199)
        left -= 1990;
    else if (left >= 2600 && left <= 2651)
        left -= 2265;
    else if (left >= 3800 && left <= 3989)
        left -= 3490;
    else if (left >= 4100 && left <= 4199)
        left -= 3890;
    return left * 1000000 + uin % 1000000;
}

function int32ip2str(ip) {
    if (typeof ip === "string")
        return ip;
    ip = ip & 0xffffffff;
    return [
        ip & 0xff,
        (ip & 0xff00) >> 8,
        (ip & 0xff0000) >> 16,
        (ip & 0xff000000) >> 24 & 0xff,
    ].join(".");
}

/** 解析彩色群名片 */
function parseFunString(buf) {
    if (buf[0] === 0xA) {
        let res = "";
        try {
            let arr = core_1.pb.decode(buf)[1];
            if (!Array.isArray(arr))
                arr = [arr];
            for (let v of arr) {
                if (v[2])
                    res += String(v[2]);
            }
        }
        catch { }
        return res;
    }
    else {
        return String(buf);
    }
}

/** xml转义 */
function escapeXml(str) {
    return str.replace(/[&"><]/g, function (s) {
        if (s === "&")
            return "&amp;";
        if (s === "<")
            return "&lt;";
        if (s === ">")
            return "&gt;";
        if (s === "\"")
            return "&quot;";
        return "";
    });
}

/** 用于下载限量 */
class DownloadTransform extends stream.Transform {
    constructor() {
        super(...arguments);
        this._size = 0;
    }
    _transform(data, encoding, callback) {
        this._size += data.length;
        let error = null;
        if (this._size <= MAX_UPLOAD_SIZE)
            this.push(data);
        else
            error = new Error("downloading over 30MB is refused");
        callback(error);
    }
}
const IS_WIN = os.platform() === "win32";
/** 系统临时目录，用于临时存放下载的图片等内容 */
const TMP_DIR = os.tmpdir();
/** 最大上传和下载大小，以图片上传限制为准：30MB */
const MAX_UPLOAD_SIZE = 31457280;

/** no operation */
const NOOP = () => { };

/** promisified pipeline */
const pipeline = (0, util.promisify)(stream.pipeline);
/** md5 hash */
const md5 = (data) => (0, crypto.createHash)("md5").update(data).digest();