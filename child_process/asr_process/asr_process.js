const portAudio = require('naudiodon2');
const { join } = require('path');
const sherpa_onnx = require('sherpa-onnx-node');
const get_config = require('./get_config');


// const logger = require('../../src/utils/logger');

const winston = require('winston');
let logger = null;


function initLogger(path) {
  logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.File({ filename: join(path, 'asr_process.log') })
    ]
  });
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}


function createRecognizer(message) {
  logger.info('开始创建识别器', { message });
  const config = get_config(message);
  logger.debug('识别器配置', { config });
  const recognizer = new sherpa_onnx.OfflineRecognizer(config);
  logger.info('识别器创建完成');
  return recognizer;
}

let vad_path = join(__dirname, '../../resources/model/silero_vad.onnx')

function createVad() {
  logger.info('开始创建 VAD');
  const config = {
    sileroVad: {
      model: vad_path.replace('app.asar', 'app.asar.unpacked'),
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      windowSize: 512,
    },
    sampleRate: 16000,
    debug: true,
    numThreads: 1,
  };
  logger.debug('VAD 配置', { config });
  const bufferSizeInSeconds = 60;
  const vad = new sherpa_onnx.Vad(config, bufferSizeInSeconds);
  logger.info('VAD 创建完成');
  return vad;
}

let recognizer = null;
let vad = null;
let buffer = null;
let ai = null;

function setupASR(message) {
  logger.info('开始设置 ASR', { message });
  recognizer = createRecognizer(message);
  vad = createVad();
  const bufferSizeInSeconds = 30;
  buffer = new sherpa_onnx.CircularBuffer(bufferSizeInSeconds * vad.config.sampleRate);
  ai = new portAudio.AudioIO({
    inOptions: {
      channelCount: 1,
      closeOnError: false,
      deviceId: message.device,
      sampleFormat: portAudio.SampleFormatFloat32,
      sampleRate: vad.config.sampleRate,
      // framesPerBuffer: 1024
    }
  });
  logger.debug('音频输入设置完成', { deviceId: message.device });

  let index = 0;
  ai.on('data', data => {
    const windowSize = vad.config.sileroVad.windowSize;
    buffer.push(new Float32Array(data.buffer));
    while (buffer.size() > windowSize) {
      const samples = buffer.get(buffer.head(), windowSize);
      buffer.pop(windowSize);
      vad.acceptWaveform(samples);
    }

    while (!vad.isEmpty()) {
      const segment = vad.front();
      vad.pop();
      const stream = recognizer.createStream();
      stream.acceptWaveform({
        samples: segment.samples,
        sampleRate: recognizer.config.featConfig.sampleRate
      });
      recognizer.decode(stream);
      const r = recognizer.getResult(stream);
      if (r.text.length > 0) {
        let text = r.text.toLowerCase().trim();
        process.send(text);
        logger.debug('识别结果', { index, text });
        index += 1;
      }
    }
  });

  ai.start();
  process.send('ASR-started');
  logger.info('ASR 启动完成');
}

function stopASR() {
  logger.info('开始停止 ASR');
  ai.quit();
  recognizer = null
  vad = null
  buffer = null
  ai = null
  logger.info('ASR 已停止');
}

process.on('message', (message) => {
  if (message.model) {
    initLogger(message.logPath);
    logger.info('收到模型信息', { model: message.model });
    setupASR(message);
  } else if (message === 'stop-asr') {
    logger.info('收到停止 ASR 命令');
    stopASR()
    process.exit();
  }
});

console.log('ASR 进程初始化完成');
