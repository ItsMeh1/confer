export class LanChat {
  constructor(options = {}) {
    this.options = {
      channelName: options.channelName ?? "lanchat",
      iceServers: options.iceServers ?? [],
      ...options,
    };

    this.pc = null;
    this.channel = null;

    this.role = "idle";
    this.roomCode = this._makeRoomCode();

    this.localStream = new MediaStream();
    this.remoteStream = new MediaStream();
    this.screenStream = null;

    this.localVideoElement = null;
    this.remoteVideoElement = null;

    this._mediaSenders = new Map();
    this._screenSenders = new Map();

    this.lastOfferText = "";
    this.lastAnswerText = "";
    this.lastRemoteText = "";
    this.lastMessage = "";

    this.onmessage = null;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onstatechange = null;
    this.onlocalstream = null;
    this.onremotestream = null;
    this.onscreenstream = null;
    this.ontrack = null;
  }

  get state() {
    return {
      role: this.role,
      roomCode: this.roomCode,
      connectionState: this.pc?.connectionState ?? "idle",
      iceConnectionState: this.pc?.iceConnectionState ?? "idle",
      signalingState: this.pc?.signalingState ?? "idle",
      channelState: this.channel?.readyState ?? "idle",
      localTracks: this.localStream?.getTracks?.().length ?? 0,
      remoteTracks: this.remoteStream?.getTracks?.().length ?? 0,
      screenTracks: this.screenStream?.getTracks?.().length ?? 0,
      lastOfferText: this.lastOfferText,
      lastAnswerText: this.lastAnswerText,
      lastRemoteText: this.lastRemoteText,
      lastMessage: this.lastMessage,
      hasPeer: !!this.pc && this.pc.connectionState !== "closed",
      hasChannel: !!this.channel,
    };
  }

  get connected() {
    return this.channel?.readyState === "open";
  }

  get hasLocalAudio() {
    return this.localStream.getAudioTracks().length > 0;
  }

  get hasLocalVideo() {
    return this.localStream.getVideoTracks().length > 0;
  }

  get hasScreenShare() {
    return !!this.screenStream && this.screenStream.getVideoTracks().length > 0;
  }

  _emit(name, value) {
    const fn = this[name];
    if (typeof fn !== "function") return;
    try {
      fn(value);
    } catch (err) {
      console.error(`LanChat callback error in ${name}:`, err);
    }
  }

  _makeRoomCode(length = 6) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < length; i++) {
      out += chars[bytes[i] % chars.length];
    }
    return out;
  }

  _makePeer() {
    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers });

    pc.onconnectionstatechange = () => {
      this._emit("onstatechange", this.state);
      if (pc.connectionState === "failed") {
        this._emit("onerror", new Error("Peer connection failed."));
      }
    };

    pc.onsignalingstatechange = () => this._emit("onstatechange", this.state);

    pc.oniceconnectionstatechange = () => {
      this._emit("onstatechange", this.state);
      if (pc.iceConnectionState === "failed") {
        this._emit("onerror", new Error("ICE connection failed."));
      }
    };

    pc.onicecandidateerror = (event) => {
      this._emit(
        "onerror",
        new Error(`ICE candidate error: ${event.errorCode} ${event.errorText || ""}`)
      );
    };

    pc.ontrack = (event) => {
      const track = event.track;
      if (!track) return;

      if (!this.remoteStream.getTracks().some((t) => t.id === track.id)) {
        this.remoteStream.addTrack(track);

        track.onended = () => {
          try {
            this.remoteStream.removeTrack(track);
          } catch {}
          this._emit("onremotestream", this.remoteStream);
          this._emit("onstatechange", this.state);
        };
      }

      if (this.remoteVideoElement) {
        this.remoteVideoElement.srcObject = this.remoteStream;
      }

      this._emit("onremotestream", this.remoteStream);
      this._emit("ontrack", {
        track: track,
        streams: event.streams,
        transceiver: event.transceiver,
      });
      this._emit("onstatechange", this.state);
    };

    pc.ondatachannel = (event) => {
      this._attachChannel(event.channel);
    };

    return pc;
  }

  _attachChannel(channel) {
    this.channel = channel;

    channel.onopen = () => {
      this._emit("onopen", this.state);
      this._emit("onstatechange", this.state);
    };

    channel.onclose = () => {
      this._emit("onclose", this.state);
      this._emit("onstatechange", this.state);
    };

    channel.onerror = (event) => {
      this._emit("onerror", event);
    };

    channel.onmessage = (event) => {
      this.lastMessage = event.data;
      this._emit("onmessage", event.data);
      this._emit("onstatechange", this.state);
    };
  }

  _parseJSON(text) {
    if (!text || !String(text).trim()) {
      throw new Error("Paste box is empty.");
    }
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object") {
      throw new Error("Invalid JSON object.");
    }
    return obj;
  }

  _validateDescription(desc, expectedType) {
    if (!desc || typeof desc !== "object") {
      throw new Error(`Invalid ${expectedType}: not an object.`);
    }
    if (desc.type !== expectedType) {
      throw new Error(`Expected ${expectedType}, got ${desc.type || "undefined"}.`);
    }
    if (!desc.sdp || typeof desc.sdp !== "string") {
      throw new Error(`Invalid ${expectedType}: missing SDP.`);
    }
    return desc;
  }

  async _waitForIceComplete() {
    if (!this.pc) return;
    if (this.pc.iceGatheringState === "complete") return;

    return new Promise((resolve) => {
      const cleanup = () => {
        this.pc?.removeEventListener("icegatheringstatechange", onIceGatheringChange);
        this.pc?.removeEventListener("connectionstatechange", onConnectionChange);
      };

      const onIceGatheringChange = () => {
        if (this.pc?.iceGatheringState === "complete") {
          cleanup();
          resolve();
        }
      };

      const onConnectionChange = () => {
        if (this.pc?.connectionState === "closed" || this.pc?.connectionState === "failed") {
          cleanup();
          resolve();
        }
      };

      this.pc.addEventListener("icegatheringstatechange", onIceGatheringChange);
      this.pc.addEventListener("connectionstatechange", onConnectionChange);
    });
  }

  _rememberLocalMedia(stream) {
    for (const track of stream.getTracks()) {
      if (track.readyState === "ended") continue;
      if (!this.localStream.getTracks().some((t) => t.id === track.id)) {
        this.localStream.addTrack(track);

        track.onended = () => {
          this._removeTrackById(track.id, "media");
          this._emit("onlocalstream", this.localStream);
          this._emit("onstatechange", this.state);
        };
      }
    }

    if (this.localVideoElement) {
      this.localVideoElement.srcObject = this.localStream;
    }

    this._emit("onlocalstream", this.localStream);
    this._emit("onstatechange", this.state);
  }

  _syncLocalTracksToPeer() {
    if (!this.pc) return;

    for (const track of this.localStream.getTracks()) {
      if (track.readyState === "ended") continue;
      if (!this._mediaSenders.has(track.id)) {
        const sender = this.pc.addTrack(track, this.localStream);
        this._mediaSenders.set(track.id, sender);
      }
    }

    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) {
        if (track.readyState === "ended") continue;
        if (!this._screenSenders.has(track.id)) {
          const sender = this.pc.addTrack(track, this.screenStream);
          this._screenSenders.set(track.id, sender);
        }
      }
    }
  }

  _removeTrackById(trackId, kindGroup = "media") {
    const senderMap = kindGroup === "screen" ? this._screenSenders : this._mediaSenders;
    const stream = kindGroup === "screen" ? this.screenStream : this.localStream;

    const sender = senderMap.get(trackId);
    if (sender) {
      try {
        sender.replaceTrack(null);
      } catch {}
      try {
        if (this.pc && this.pc.connectionState !== "closed") {
          this.pc.removeTrack(sender);
        }
      } catch {}
      senderMap.delete(trackId);
    }

    const track = stream?.getTracks?.().find((t) => t.id === trackId);
    if (track) {
      try {
        track.stop();
      } catch {}
      try {
        stream.removeTrack(track);
      } catch {}
    }
  }

  _toggleTracks(stream, kind, enabled) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      if (track.kind === kind) track.enabled = enabled;
    }
  }

  _clearRemoteStream() {
    if (!this.remoteStream) return;
    for (const track of this.remoteStream.getTracks().slice()) {
      try {
        this.remoteStream.removeTrack(track);
      } catch {}
      try {
        track.stop();
      } catch {}
    }
    if (this.remoteVideoElement) {
      this.remoteVideoElement.srcObject = this.remoteStream;
    }
  }

  attachLocalVideo(element) {
    this.localVideoElement = element || null;
    if (this.localVideoElement) {
      this.localVideoElement.srcObject = this.localStream;
    }
  }

  attachRemoteVideo(element) {
    this.remoteVideoElement = element || null;
    if (this.remoteVideoElement) {
      this.remoteVideoElement.srcObject = this.remoteStream;
    }
  }

  exportState() {
    return JSON.stringify(this.state, null, 2);
  }

  resetRoomCode() {
    this.roomCode = this._makeRoomCode();
    this._emit("onstatechange", this.state);
    return this.roomCode;
  }

  async enableMedia(constraints = { audio: true, video: true }) {
    const kinds = [];
    if (constraints.audio) kinds.push("audio");
    if (constraints.video) kinds.push("video");

    for (const kind of kinds) {
      const tracks = this.localStream.getTracks().filter((t) => t.kind === kind);
      for (const track of tracks) {
        this._removeTrackById(track.id, "media");
      }
    }

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this._rememberLocalMedia(stream);
    this._syncLocalTracksToPeer();
    return stream;
  }

  async enableMicrophone() {
    return this.enableMedia({ audio: true, video: false });
  }

  async enableCamera() {
    return this.enableMedia({ audio: false, video: true });
  }

  async disableMicrophone() {
    const tracks = this.localStream.getAudioTracks().slice();
    for (const track of tracks) {
      this._removeTrackById(track.id, "media");
    }
    this._emit("onlocalstream", this.localStream);
    this._emit("onstatechange", this.state);
  }

  async disableCamera() {
    const tracks = this.localStream.getVideoTracks().slice();
    for (const track of tracks) {
      this._removeTrackById(track.id, "media");
    }
    this._emit("onlocalstream", this.localStream);
    this._emit("onstatechange", this.state);
  }

  muteMicrophone() {
    this._toggleTracks(this.localStream, "audio", false);
    this._emit("onstatechange", this.state);
  }

  unmuteMicrophone() {
    this._toggleTracks(this.localStream, "audio", true);
    this._emit("onstatechange", this.state);
  }

  muteCamera() {
    this._toggleTracks(this.localStream, "video", false);
    this._emit("onstatechange", this.state);
  }

  unmuteCamera() {
    this._toggleTracks(this.localStream, "video", true);
    this._emit("onstatechange", this.state);
  }

  async shareScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Screen sharing is not supported in this browser.");
    }

    this.stopScreenShare();

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
    } catch (err) {
      this._emit("onstatechange", this.state);
      throw err;
    }

    this.screenStream = stream;
    this._emit("onscreenstream", this.screenStream);

    if (this.pc) {
      for (const track of stream.getTracks()) {
        if (!this._screenSenders.has(track.id)) {
          const sender = this.pc.addTrack(track, stream);
          this._screenSenders.set(track.id, sender);
        }
      }
    }

    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      this.stopScreenShare();
    });

    this._emit("onstatechange", this.state);
    return stream;
  }

  stopScreenShare() {
    if (!this.screenStream) return;

    const tracks = this.screenStream.getTracks().slice();
    for (const track of tracks) {
      this._removeTrackById(track.id, "screen");
    }

    this.screenStream = null;
    this._emit("onscreenstream", null);
    this._emit("onstatechange", this.state);
  }

  async host() {
    this.close({ keepMedia: true });
    this.role = "host";
    this.pc = this._makePeer();

    this.channel = this.pc.createDataChannel(this.options.channelName);
    this._attachChannel(this.channel);

    this._syncLocalTracksToPeer();

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._waitForIceComplete();

    this.lastOfferText = JSON.stringify(this.pc.localDescription, null, 2);
    this._emit("onstatechange", this.state);
    return this.lastOfferText;
  }

  async join(offerText) {
    this.close({ keepMedia: true });
    this.role = "join";
    this.pc = this._makePeer();

    const offer = this._parseJSON(offerText);
    this._validateDescription(offer, "offer");
    await this.pc.setRemoteDescription(offer);

    this._syncLocalTracksToPeer();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this._waitForIceComplete();

    this.lastRemoteText = offerText;
    this.lastAnswerText = JSON.stringify(this.pc.localDescription, null, 2);
    this._emit("onstatechange", this.state);
    return this.lastAnswerText;
  }

  async accept(answerText) {
    if (!this.pc) throw new Error("No peer connection yet.");
    if (this.role !== "host") throw new Error("Only the host can accept an answer.");

    const answer = this._parseJSON(answerText);
    this._validateDescription(answer, "answer");
    await this.pc.setRemoteDescription(answer);
    this.lastRemoteText = answerText;
    this._emit("onstatechange", this.state);
  }

  send(data) {
    if (!this.channel) throw new Error("No data channel yet.");
    if (this.channel.readyState !== "open") {
      throw new Error("Channel is not open yet.");
    }

    if (
      data instanceof Blob ||
      data instanceof ArrayBuffer ||
      ArrayBuffer.isView(data)
    ) {
      this.channel.send(data);
      return;
    }

    if (typeof data === "object" && data !== null) {
      this.channel.send(JSON.stringify(data));
      return;
    }

    this.channel.send(String(data));
  }

  sendText(text) {
    this.send(String(text));
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  sendBinary(binary) {
    this.send(binary);
  }

  async copyOfferText() {
    if (!navigator.clipboard) throw new Error("Clipboard API is not available.");
    await navigator.clipboard.writeText(this.lastOfferText);
  }

  async copyAnswerText() {
    if (!navigator.clipboard) throw new Error("Clipboard API is not available.");
    await navigator.clipboard.writeText(this.lastAnswerText);
  }

  close({ keepMedia = true } = {}) {
    this._clearRemoteStream();

    try {
      if (this.channel && this.channel.readyState !== "closed") {
        this.channel.close();
      }
    } catch {}

    try {
      if (this.pc) this.pc.close();
    } catch {}

    this.channel = null;
    this.pc = null;
    this.role = "idle";
    this._mediaSenders.clear();
    this._screenSenders.clear();

    if (!keepMedia) {
      for (const track of this.localStream.getTracks().slice()) {
        try { track.stop(); } catch {}
        try { this.localStream.removeTrack(track); } catch {}
      }

      if (this.screenStream) {
        for (const track of this.screenStream.getTracks().slice()) {
          try { track.stop(); } catch {}
          try { this.screenStream.removeTrack(track); } catch {}
        }
        this.screenStream = null;
      }
    }

    if (this.localVideoElement) this.localVideoElement.srcObject = this.localStream;
    if (this.remoteVideoElement) this.remoteVideoElement.srcObject = this.remoteStream;

    this._emit("onstatechange", this.state);
  }
}