const sleep = t => new Promise(resolve => setTimeout(resolve, t))
const fromHex = hex => Uint8Array.from(hex.replace(/\s/g, '').match(/../g), b => parseInt(b, 16))
const fromBase64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

const WEBSERIAL_FILTERS = [
  // http://www.linux-usb.org/usb.ids
  // about://device-log
  { usbVendorId: 0x0557, usbProductId: 0x2008 }, // 0557: ATEN International Co., Ltd, 2008: UC-232A Serial Port [pl2303]
  { usbVendorId: 0x067B, usbProductId: 0x04BB }, // 067B: Prolific Technology, Inc., 04BB: PL2303 Serial (IODATA USB-RSAQ2)
  { usbVendorId: 0x067B, usbProductId: 0x2303 }, // 067B: Prolific Technology, Inc., 2303: PL2303 Serial Port
  { usbVendorId: 0x067B, usbProductId: 0xAAA2 }, // 067B: Prolific Technology, Inc., AAA2: PL2303 Serial Adapter (IODATA USB-RSAQ3)
  { usbVendorId: 0x067B, usbProductId: 0xAAA3 }, // 067B: Prolific Technology, Inc., AAA3: PL2303x Serial Adapter
  { usbVendorId: 0x1A86, usbProductId: 0x5523 }, // 1A86: QinHeng Electronics, 5523: CH341 in serial mode, usb to serial port converter
  { usbVendorId: 0x1A86, usbProductId: 0x7522 }, // 1A86: QinHeng Electronics, 7522: CH340 serial converter
  { usbVendorId: 0x1A86, usbProductId: 0x7523 }, // 1A86: QinHeng Electronics, 7523: CH340 serial converter
  { usbVendorId: 0x10C4, usbProductId: 0xEA60 }, // 10C4: Silicon Labs, EA60: CP210x UART Bridge
  { usbVendorId: 0x10C4, usbProductId: 0xEA61 }, // 10C4: Silicon Labs, EA61: CP210x UART Bridge
  { usbVendorId: 0x10C4, usbProductId: 0xEA63 }, // 10C4: Silicon Labs, EA63: CP210x UART Bridge
  { usbVendorId: 0x4A50, usbProductId: 0x4C69 }, // 4A50: ???, 4C69: GO2NFC141U
]

function concatBytes (a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a); out.set(b, a.length)
  return out
}

// --- minimal NDEF encode/decode (single MIME record only, which is all the
// Tamagotchi protocol uses) ----------------------------------------------

const Ndef = {
  mimeMediaRecord (mimeType, payload) {
    return { type: mimeType, payload: Uint8Array.from(payload) }
  },

  encodeMessage ([{ type, payload }]) {
    const typeBytes = new TextEncoder().encode(type)
    const sr = payload.length < 0xFF
    const tnfByte = 0xC2 | (sr ? 0x10 : 0) // MB|ME|TNF=MIME_MEDIA, +SR
    const header = sr
      ? [tnfByte, typeBytes.length, payload.length]
      : [tnfByte, typeBytes.length, (payload.length >>> 24) & 0xFF, (payload.length >>> 16) & 0xFF, (payload.length >>> 8) & 0xFF, payload.length & 0xFF]
    return new Uint8Array([...header, ...typeBytes, ...payload])
  },

  decodeMessage (bytes) {
    bytes = Array.from(bytes)
    const tnfByte = bytes.shift()
    const sr = (tnfByte & 0x10) !== 0
    const typeLength = bytes.shift()
    const payloadLength = sr
      ? bytes.shift()
      : ((bytes.shift() & 0xFF) << 24) | ((bytes.shift() & 0xFF) << 16) | ((bytes.shift() & 0xFF) << 8) | (bytes.shift() & 0xFF)
    bytes.splice(0, typeLength) // skip type, we only ever decode our own record
    return new Uint8Array(bytes.splice(0, payloadLength))
  },
}

// --- PN532 frame parsing ----------------------------------------------------
// normal frames only (LEN <= 253). nothing this project sends ever needs an
// extended frame, so the PN532 never replies with one either (hopefully).

function findFrameLen (buf) {
  if (buf.length >= 6 && buf[5] === 0) {
    const w = buf[3] | (buf[4] << 8) // little-endian, matches DataView.getUint16(3, true)
    if (w === 0xFF00 || w === 0x00FF) return 6 // ACK/NACK
  }
  if (buf.length >= 8 && ((buf[3] + buf[4]) & 0xFF) === 0) return buf[3] + 7 // normal frame
  return 0
}

function parseFrame (pack) {
  if (pack.length === 6) {
    const w = pack[3] | (pack[4] << 8)
    return { ack: w === 0xFF00 }
  }
  if ((pack[3] + pack[4]) & 0xFF) return { err: 'invalid len/lcs' }
  let dcs = 0
  for (const b of pack.subarray(5, pack.length - 1)) dcs += b
  if (dcs & 0xFF) return { err: 'invalid dcs' }
  return { cmd: pack[6], data: pack.subarray(7, pack.length - 2) }
}

// --- PN532 core --------------------------------------------------------------

class Pn532 {
  constructor () {
    this.adapter = null // set by `new WebserialAdapter(pn532)`
    this.respBuf = []
    this.rxBuf = new Uint8Array(0)
    this.tx = null

    this.rx = new TransformStream({
      transform: (chunk, controller) => {
        this.rxBuf = concatBytes(this.rxBuf, chunk)
        while (true) {
          const offset = this.rxBuf.indexOf(0)
          if (offset === -1) return
          const buf = this.rxBuf.subarray(offset)
          const len = findFrameLen(buf)
          if (!len || buf.length < len) { this.rxBuf = buf; return }
          controller.enqueue(parseFrame(buf.subarray(0, len)))
          this.rxBuf = buf.subarray(len)
        }
      },
    })

    this.rx.readable.pipeTo(new WritableStream({
      write: frame => { this.respBuf.push(frame) },
    }))
  }

  async writePacket (pack) {
    if (!this.adapter) throw new Error('no adapter attached, e.g. new WebserialAdapter(pn532)')
    if (!this.adapter.open) await this.adapter.connect()
    const writer = this.tx.writable.getWriter()
    await writer.write(pack)
    writer.releaseLock()
  }

  async sendCommandNormal ({ cmd, data = new Uint8Array(0) }) {
    if (data.length > 253) throw new TypeError('data.length > 253')
    const len = data.length + 2
    const pack = new Uint8Array(data.length + 9) // PREAMBLE(2) + START(1) + LEN + LCS + TFI + CMD + Data + DCS + POSTAMBLE
    pack[2] = 0xFF; pack[3] = len; pack[4] = (-len) & 0xFF; pack[5] = 0xD4; pack[6] = cmd
    pack.set(data, 7)
    const dcsIdx = pack.length - 2
    let dcs = 0
    for (const b of pack.subarray(5, dcsIdx)) dcs -= b
    pack[dcsIdx] = dcs & 0xFF
    await this.writePacket(pack)
  }

  async sendCommandWakeup () {
    await this.writePacket(fromHex('55550000000000000000000000000000FF05FBD4140114010200'))
    await this.readRespTimeout({ cmd: 0x15 })
  }

  async resetSettings () {
    await this.setParameters(0x14) // PARAM_AUTO_ATR_RES | PARAM_AUTO_RATS
    await this.updateRegistersWithMask([
      { adr: 0x6302, mask: 0x80, value: 0x80 }, // CIU_TxMode, TX_CRC_ENABLE
      { adr: 0x6303, mask: 0x80, value: 0x80 }, // CIU_RxMode, RX_CRC_ENABLE
      { adr: 0x630D, mask: 0x10, value: 0x00 }, // CIU_ManualRCV, PARITY_DISABLE off
      { adr: 0x6338, mask: 0x08, value: 0x00 }, // CIU_Status2, MF_CRYPTO1_ON off
      { adr: 0x633D, mask: 0x07, value: 0x00 }, // CIU_BitFraming, TX_LAST_BITS
    ])
  }

  clearRespBuf () { this.respBuf.length = 0 }

  async readRespTimeout ({ cmd = null, timeout = 5e3 }) {
    const startedAt = Date.now()
    while (true) {
      if (!this.adapter?.open) throw new Error('device disconnected')
      if (Date.now() > startedAt + timeout) throw new Error(`readRespTimeout ${timeout}ms`)
      while (this.respBuf.length) {
        const resp = this.respBuf.shift()
        if (resp.err) continue
        if ('ack' in resp) {
          if (!resp.ack) throw new Error('receive nack')
          continue
        }
        if (cmd != null && resp.cmd !== cmd) continue
        return resp
      }
      await sleep(10)
    }
  }

  async getFirmwareVersion () {
    this.clearRespBuf()
    await this.sendCommandNormal({ cmd: 0x02 })
    const { data } = await this.readRespTimeout({ cmd: 0x03 })
    return {
      firmware: `${data[1]}.${data[2]}`,
      ic: `PN5${data[0].toString(16).toUpperCase().padStart(2, '0')}`,
      iso14443a: (data[3] & 0b1) > 0,
      iso14443b: (data[3] & 0b10) > 0,
      iso18092: (data[3] & 0b100) > 0,
    }
  }

  async readRegisters (adrs) {
    const reqData = new Uint8Array(adrs.length * 2)
    adrs.forEach((adr, i) => { reqData[i * 2] = adr >> 8; reqData[i * 2 + 1] = adr & 0xFF })
    this.clearRespBuf()
    await this.sendCommandNormal({ cmd: 0x06, data: reqData })
    const { data } = await this.readRespTimeout({ cmd: 0x07 })
    const regs = {}
    adrs.forEach((adr, i) => { regs[adr] = data[i] })
    return regs
  }

  async writeRegisters (regs) {
    const pairs = Object.entries(regs)
    const reqData = new Uint8Array(pairs.length * 3)
    pairs.forEach(([adr, value], i) => { reqData[i * 3] = adr >> 8; reqData[i * 3 + 1] = adr & 0xFF; reqData[i * 3 + 2] = value })
    this.clearRespBuf()
    await this.sendCommandNormal({ cmd: 0x08, data: reqData })
    await this.readRespTimeout({ cmd: 0x09 })
  }

  async updateRegistersWithMask (rows) {
    const adrs = [...new Set(rows.map(row => row.adr))]
    const regs = await this.readRegisters(adrs)
    for (const { adr, mask, value } of rows) regs[adr] = (regs[adr] & (~mask & 0xFF)) | (value & mask)
    await this.writeRegisters(regs)
  }

  async setParameters (flags) {
    this.clearRespBuf()
    await this.sendCommandNormal({ cmd: 0x12, data: new Uint8Array([flags & 0xFF]) })
    await this.readRespTimeout({ cmd: 0x13 })
  }

  async rfConfiguration ({ item, data = new Uint8Array(0) }) {
    this.clearRespBuf()
    await this.sendCommandNormal({ cmd: 0x32, data: new Uint8Array([item, ...data]) })
    await this.readRespTimeout({ cmd: 0x33 })
  }
}

// --- WebSerial adapter -------------------------------------------------------

class WebserialAdapter {
  constructor (pn532) {
    if (pn532.adapter) throw new Error('adapter already attached')
    this.pn532 = pn532
    this.port = null
    this.open = false
    pn532.adapter = this
  }

  async disconnect () {
    if (this.port) await this.port.close()
  }

  onDisconnected () {
    this.open = false
    this.port = null
    console.log('device disconnected')
  }

  async connect () {
    try {
      if (!navigator.serial) throw new Error('WebSerial not supported (use desktop Chrome/Edge)')

      this.port = await navigator.serial.requestPort({ filters: WEBSERIAL_FILTERS })
      if (!this.port) throw new Error('user canceled')
      const info = this.port.getInfo()
      console.log(`port selected, usbVendorId = ${info.usbVendorId}, usbProductId = ${info.usbProductId}`)

      await this.port.open({ baudRate: 115200 })
      this.pn532.tx = this.port
      this.port.readable.pipeTo(this.pn532.rx.writable)
      this.port.addEventListener('disconnect', () => this.onDisconnected())
      this.open = true

      await this.pn532.sendCommandWakeup()
      await this.pn532.resetSettings()
    } catch (err) {
      this.onDisconnected()
      throw err
    }
  }
}

function TamagotchiP2p (pn532) {
  // --- PN532 raw commands ----------------------------------------------------

  async function tgInitAsTarget (timeoutMs = 30000) {
    await pn532.setParameters(0x00)

    await pn532.rfConfiguration({ item: 0x02, data: fromHex('00 0B 0A') })
    await pn532.rfConfiguration({ item: 0x04, data: fromHex('00') })
    await pn532.rfConfiguration({ item: 0x05, data: fromHex('01 00 01') })

    await pn532.rfConfiguration({ item: 0x0A, data: fromHex('59 F4 3F 11 4D 85 61 6F 26 62 87') })
    await pn532.rfConfiguration({ item: 0x0B, data: fromHex('69 FF 3F 11 41 85 61 6F') })
    await pn532.rfConfiguration({ item: 0x0C, data: fromHex('FF 04 85') })
    await pn532.rfConfiguration({ item: 0x0D, data: fromHex('85 15 8A 85 08 B2 85 01 DA') })

    await pn532.writeRegisters({
      0x6301: 0b01111011, // CIU_Mode
      0x6302: 0b10110000, // CIU_TxMode
      0x6303: 0b10110000, // CIU_RxMode
    })

    for (let retries = 0; retries < 10; retries++) {
      // generate random identifiers every call
      const idm = new Uint8Array(8)
      crypto.getRandomValues(idm)
      idm[0] = 0x01; idm[1] = 0xFE // NFC-DEP IDm prefix

      const uid3 = new Uint8Array(3)
      crypto.getRandomValues(uid3)

      // nfcaParams: ATQA(2) + uid3(3) + SAK(1) = 6 bytes
      const nfcaParams = new Uint8Array([0x01, 0x01, ...uid3, 0x40]) // ATQA, uid3, SAK (NFC-DEP bit)

      // nfcfParams: IDm(8) + PMm(8, zero) + Sys(2) = 18 bytes
      const nfcfParams = new Uint8Array(18)
      nfcfParams.set(idm, 0)
      nfcfParams[16] = 0xFF; nfcfParams[17] = 0xFF // Sys = FF FF

      // nfcid3: IDm + 00 00 = 10 bytes
      const nfcid3 = new Uint8Array(10)
      nfcid3.set(idm, 0)

      // our LLCP params in ATR GI
      // magic(3) + VERSION(3) + MIUX(4) + WKS(4) + LTO(3) + OPT(3)
      const gi = fromHex('46 66 6D 01 01 13 02 02 07 FF 03 02 00 13 04 01 96 07 01 03')

      // TgInitAsTarget payload: mode(1) + nfcaParams(6) + nfcfParams(18) + nfcid3(10) + gi_len(1)=0 + hi_len(1)=0
      const cmd = new Uint8Array([0x00, ...nfcaParams, ...nfcfParams, ...nfcid3, 0x00, 0x00])

      pn532.clearRespBuf()
      console.debug('TamagotchiP2p.tgInitAsTarget: sending TgInitAsTarget cmd=', cmd.toHex())
      await pn532.sendCommandNormal({ cmd: 0x8C, data: cmd })
      const resp = await pn532.readRespTimeout({ cmd: 0x8D, timeout: timeoutMs })
      if (!resp?.data || resp.data.length < 4) {
        console.error('TgInitAsTarget: no response or too short')
        continue
      }

      // resp.data: [mode, length, ...ATR_REQ (starting with D4 00)]
      if (resp.data[2] !== 0xD4 || resp.data[3] !== 0x00) {
        console.error(`TgInitAsTarget: unexpected response D${resp.data[2].toString(16)} ${resp.data[3].toString(16)}, expected D4 00`)
        continue
      }

      // ATR_REQ fields: D4 00 NFCID3i(10) DID BS BR PP [GI...]
      const atrReq = resp.data.subarray(2)
      const pp = atrReq[15]
      const remoteGi = (pp & 0x02) ? atrReq.subarray(16) : new Uint8Array(0)

      // parse remote MIU from their GI (after 3-byte magic)
      let remoteMiu = 128
      if (remoteGi.length > 3) {
        let idx = 3
        while (idx + 1 < remoteGi.length) {
          const t = remoteGi[idx]; const l = remoteGi[idx + 1]; idx += 2
          if (t === 0x02 && l >= 2) remoteMiu = 128 + (((remoteGi[idx] & 0x07) << 8) | remoteGi[idx + 1])
          idx += l
        }
      }

      const did = atrReq[12]

      // ATR_RES: D5 01 NFCID3t(10) DID BS BR TO PP GI. TO=8, PP=0x32 (LR=3, GI present)
      const atrRes = new Uint8Array([0xD5, 0x01, ...nfcid3, did, 0x00, 0x00, 0x08, 0x32, ...gi])
      const atrResPayload = new Uint8Array([atrRes.length + 1, ...atrRes]) // TgResponseToInitiator wants [len+1, ...atrRes]

      pn532.clearRespBuf()
      console.debug('TamagotchiP2p.tgInitAsTarget: sending ATR_RES=', atrResPayload.toHex())
      await pn532.sendCommandNormal({ cmd: 0x90, data: atrResPayload })
      const atrResp = await pn532.readRespTimeout({ cmd: 0x91, timeout: 2000 })
      if (!atrResp?.data || atrResp.data[0] !== 0) {
        console.error(`TgResponseToInitiator(ATR_RES) error: 0x${atrResp?.data?.[0]?.toString(16) ?? '??'}`)
        continue
      }
      console.debug('TamagotchiP2p.tgInitAsTarget: ATR_RES accepted, remoteMiu=', remoteMiu, 'did=', did)

      return { remoteMiu }
    }

    throw new Error('TgInitAsTarget: failed after multiple retries')
  }

  async function tgSend (frameBytes, timeoutMs = 2000) {
    console.debug('TamagotchiP2p.tgSend: frameBytes=', frameBytes.toHex())
    pn532.clearRespBuf()
    await pn532.sendCommandNormal({ cmd: 0x90, data: frameBytes })
    const resp = await pn532.readRespTimeout({ cmd: 0x91, timeout: timeoutMs })
    if (resp.data[0] !== 0) throw new Error(`TgResponseToInitiator error 0x${resp.data[0].toString(16)}`)
  }

  async function tgRecv (timeoutMs = 2000) {
    pn532.clearRespBuf()
    await pn532.sendCommandNormal({ cmd: 0x88, data: new Uint8Array(0) })
    const resp = await pn532.readRespTimeout({ cmd: 0x89, timeout: timeoutMs })
    if (resp.data[0] !== 0) throw new Error(`TgGetInitiatorCommand error 0x${resp.data[0].toString(16)}`)
    console.debug('TamagotchiP2p.tgRecv: data=', resp.data.toHex())
    return resp.data.subarray(1) // strip status byte
  }

  class DEP {
    pni = 0

    parseDepFrame (raw) {
      const len = raw[0] // LEN counts itself
      const inner = raw.subarray(1, len)
      if (inner[0] !== 0xD4 || inner[1] !== 0x06) {
        throw new Error(`Expected DEP_REQ D4 06, got ${inner[0].toString(16)} ${inner[1].toString(16)}`)
      }
      const pfb = inner[2]
      const pni = pfb & 0x03
      const didPresent = (pfb >> 2) & 0x01
      const nadPresent = (pfb >> 3) & 0x01
      let o = 3
      if (didPresent) o++
      if (nadPresent) o++
      return { pni, llcp: inner.subarray(o) }
    }

    buildDepFrame (llcp, pni) {
      // <len> D5 07 <pfb> <llcp> - no NAD/DID needed for our use case, LLCP spec 6.2.1
      const inner = new Uint8Array([0xD5, 0x07, pni & 0x03, ...llcp])
      return new Uint8Array([inner.length + 1, ...inner]) // LEN counts itself
    }

    async send (llcp) {
      await tgSend(this.buildDepFrame(llcp, this.pni))
      this.pni = (this.pni + 1) & 0x03
    }

    async recv (timeoutMs = 2000) {
      const dep = this.parseDepFrame(await tgRecv(timeoutMs))
      this.pni = dep.pni
      return dep.llcp
    }

    async transceive (llcp, timeoutMs = 2000) {
      await this.send(llcp)
      return await this.recv(timeoutMs)
    }
  }

  // --- LLCP helpers ---------------------------------------------------------

  const PTYPE = { SYMM: 0, CONNECT: 4, DISC: 5, CC: 6, DM: 7, I: 0xC, RR: 0xD }

  function llcpHdr (dsap, ptype, ssap) {
    const w = ((dsap & 0x3F) << 10) | ((ptype & 0x0F) << 6) | (ssap & 0x3F)
    return [w >> 8, w & 0xFF]
  }

  function parseLlcpHdr (b) {
    const w = (b[0] << 8) | b[1]
    return { dsap: (w >> 10) & 0x3F, ptype: (w >> 6) & 0x0F, ssap: w & 0x3F }
  }

  const buildI = (dsap, ssap, ns, nr, payload) => new Uint8Array([...llcpHdr(dsap, PTYPE.I, ssap), ((ns & 0x0F) << 4) | (nr & 0x0F), ...payload])
  const buildRR = (dsap, ssap, nr) => new Uint8Array([...llcpHdr(dsap, PTYPE.RR, ssap), nr & 0x0F])
  const buildDM = (dsap, ssap, nr) => new Uint8Array([...llcpHdr(dsap, PTYPE.DM, ssap), nr & 0x0F])
  const parseI = llcp => ({ ns: (llcp[2] >> 4) & 0x0F, nr: llcp[2] & 0x0F, payload: llcp.subarray(3) })

  // Parse MIU from CC TLVs (after 2-byte LLCP header)
  function parseCCMiu (llcp) {
    let miu = 128; let o = 2
    while (o + 1 < llcp.length) {
      const t = llcp[o]; const l = llcp[o + 1]; o += 2
      if (t === 0x02 && l >= 2) miu = 128 + (((llcp[o] & 0x07) << 8) | llcp[o + 1])
      o += l
    }
    return miu
  }

  // --- SNEP helpers ---------------------------------------------------------

  const snepPut = ndefBytes => new Uint8Array([0x10, 0x02, (ndefBytes.length >>> 24) & 0xFF, (ndefBytes.length >>> 16) & 0xFF, (ndefBytes.length >>> 8) & 0xFF, ndefBytes.length & 0xFF, ...ndefBytes])
  const parseSnepHdr = data => ({ code: data[1], length: (data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5] })

  // --- main exchange loop ---------------------------------------------------

  /**
   * here we are the SNEP client: connect to Tamagotchi's SNEP server at SAP 4
   * and PUT our NDEF message.
   */
  async function sendNdef (ndefBytes) {
    const { remoteMiu } = await tgInitAsTarget(30000)
    const maxPay = Math.min(remoteMiu, 128) - 3

    const dep = new DEP()

    const h0 = parseLlcpHdr(await dep.recv())
    if (h0.ptype !== PTYPE.SYMM) throw new Error(`Expected SYMM after ATR, got PTYPE=${h0.ptype}`)

    const ccPdu = await dep.transceive(new Uint8Array(llcpHdr(4, PTYPE.CONNECT, 32)))
    const h1 = parseLlcpHdr(ccPdu)
    if (h1.ptype !== PTYPE.CC) throw new Error(`Expected CC, got PTYPE=${h1.ptype}`)
    const effectiveMax = Math.min(parseCCMiu(ccPdu), maxPay)

    const snep = snepPut(ndefBytes)
    const frags = []
    for (let i = 0; i < snep.length; i += effectiveMax) frags.push(snep.subarray(i, i + effectiveMax))

    let fi = 0
    let responsePdu = null
    let vS = 0
    let vR = 0
    while (true) {
      const ptype = responsePdu && parseLlcpHdr(responsePdu).ptype

      if (ptype === null && fi < frags.length) {
        responsePdu = await dep.transceive(buildI(4, 32, vS, vR, frags[fi]))
        console.debug(`TamagotchiP2p.sendNdef: sent frag ${fi + 1}/${frags.length}, received PTYPE=${parseLlcpHdr(responsePdu).ptype}`)
        continue
      }

      if (ptype === PTYPE.I) {
        const info = parseI(responsePdu)
        vR = (info.ns + 1) & 0x0F
        vS = info.nr

        const sh = parseSnepHdr(info.payload)
        if (sh.code === 0x80) { fi++; responsePdu = null; continue } // Continue

        if (sh.code === 0x81) { // Success
          await dep.send(buildRR(4, 32, vR))
          return
        }

        throw new Error(`SNEP error response 0x${sh.code.toString(16)}`)
      }

      if (ptype === PTYPE.RR) {
        vS = responsePdu[2] & 0x0F

        // RR before the Continue (first frag), or RR after the last frag while
        // waiting for SNEP Success - either way, poll again with SYMM.
        if ((fi === 0 && frags.length > 1) || fi === frags.length - 1) {
          responsePdu = await dep.transceive(new Uint8Array([0x00, 0x00]))
          continue
        }

        fi++
        responsePdu = null
        continue
      }

      throw new Error(`Unexpected PTYPE=${ptype} during data transfer`)
    }
  }

  /**
   * here we act as SNEP server (SAP 4): accept a CONNECT from the Tamagotchi,
   * receive a SNEP PUT, return the NDEF bytes.
   */
  async function receiveNdef () {
    await tgInitAsTarget(30000)

    const dep = new DEP()

    let h = parseLlcpHdr(await dep.recv())
    if (h.ptype === PTYPE.SYMM) h = parseLlcpHdr(await dep.transceive(new Uint8Array([0x00, 0x00])))
    if (h.ptype !== PTYPE.CONNECT || h.dsap !== 4) throw new Error(`Expected CONNECT to SAP 4, got DSAP=${h.dsap} PTYPE=${h.ptype}`)

    const theirSap = h.ssap
    const ccMiux = 1856
    await dep.send(new Uint8Array([
      ...llcpHdr(theirSap, PTYPE.CC, 4),
      0x02, 0x02, (ccMiux >> 8) & 0x07, ccMiux & 0xFF, // MIUX TLV
      0x05, 0x01, 0x0F, // RW=15
    ]))

    let buf = new Uint8Array(0)
    let total = null
    let received = null
    let sentContinue = false
    let vR = 0; let vS = 0

    while (true) {
      const pdu = await dep.recv()
      const h = parseLlcpHdr(pdu)

      if (h.ptype === PTYPE.SYMM || h.ptype === PTYPE.RR) {
        await dep.send(new Uint8Array([0x00, 0x00]))
        continue
      }

      if (h.ptype === PTYPE.I && h.dsap === 4 && h.ssap === theirSap) {
        const info = parseI(pdu)
        vR = (info.ns + 1) & 0x0F

        let payload = info.payload
        if (!sentContinue) {
          if (payload.length < 6) throw new Error('SNEP header truncated')
          const sh = parseSnepHdr(payload)
          if (sh.code !== 0x02) throw new Error(`Expected SNEP PUT, got code 0x${payload[1]?.toString(16)}`)
          total = sh.length
          payload = payload.subarray(6) // strip SNEP header
        }

        buf = concatBytes(buf, payload)

        if (buf.length >= total) {
          const sucPdu = buildI(theirSap, 4, vS, vR, new Uint8Array([0x10, 0x81, 0, 0, 0, 0]))
          vS = (vS + 1) & 0x0F
          await dep.send(sucPdu).catch(() => {}) // tama may already have moved on to DISC
          received = buf.subarray(0, total)
          console.debug('TamagotchiP2p.receiveNdef: received complete SNEP PUT')
          continue
        }

        if (!sentContinue) {
          const contPdu = buildI(theirSap, 4, vS, vR, new Uint8Array([0x10, 0x80, 0, 0, 0, 0]))
          vS = (vS + 1) & 0x0F
          await dep.send(contPdu)
          sentContinue = true
        } else {
          await dep.send(buildRR(theirSap, 4, vR))
        }
        continue
      }

      if (h.ptype === PTYPE.DISC) {
        await dep.send(buildDM(theirSap, 4, vR))
        return received
      }

      throw new Error(`Unexpected LLCP PTYPE=${h.ptype} DSAP=${h.dsap} SSAP=${h.ssap}`)
    }
  }

  async function send (bytes) {
    await sendNdef(Ndef.encodeMessage([Ndef.mimeMediaRecord('application/jp.co.bandai.tamagotchiapp', bytes)]))
  }

  async function receive () {
    return Ndef.decodeMessage(await receiveNdef())
  }

  return { send, receive }
}
