class PcmCaptureProcessor extends AudioWorkletProcessor {
	process(inputs) {
		const channel = inputs[0]?.[0];
		if (channel?.length) {
			const copy = new Float32Array(channel);
			this.port.postMessage(copy.buffer, [copy.buffer]);
		}
		return true;
	}
}

registerProcessor("inno-pcm-capture", PcmCaptureProcessor);
