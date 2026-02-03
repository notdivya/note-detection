import React, { useCallback, useEffect, useRef, useState } from 'react';

const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'
];

const A4_FREQ = 440;
const C0_FREQ = 16.35;

function frequencyToNoteName(frequency: number): string {
  if (frequency < C0_FREQ || frequency > 2000) return '--';
  const midiNote = 12 * Math.log2(frequency / A4_FREQ) + 69;
  const noteIndex = Math.round(midiNote) % 12;
  const octave = Math.floor(Math.round(midiNote) / 12) - 1;
  return `${NOTE_NAMES[noteIndex]}${octave}`;
}

function autoCorrelate(buffer: Float32Array, sampleRate: number): number {
  const SIZE = buffer.length;
  
  // Calculate RMS for volume threshold
  let rms = 0;
  for (let i = 0; i < SIZE; i++) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / SIZE);
  
  console.log('RMS:', rms.toFixed(4));
  
  // Lower threshold since we're amplifying the signal
  if (rms < 0.002) return -1;

  // Autocorrelation algorithm - FIX: Remove absolute value
  let bestOffset = -1;
  let bestCorr = 0;
  
  // Search range for piano notes (roughly 27.5 Hz to 4186 Hz)
  const minOffset = Math.floor(sampleRate / 4186); // Highest piano note
  const maxOffset = Math.floor(sampleRate / 27.5);  // Lowest piano note
  
  for (let offset = minOffset; offset < Math.min(maxOffset, SIZE / 2); offset++) {
    let corr = 0;
    for (let i = 0; i < SIZE - offset; i++) {
      // FIX: Proper correlation without abs()
      corr += buffer[i] * buffer[i + offset];
    }
    
    if (corr > bestCorr) {
      bestCorr = corr;
      bestOffset = offset;
    }
  }

  if (bestOffset > 0) {
    // Parabolic interpolation for better accuracy
    let y1 = 0, y2 = 0, y3 = 0;
    
    if (bestOffset > 0 && bestOffset < SIZE / 2 - 1) {
      for (let i = 0; i < SIZE - bestOffset - 1; i++) {
        y1 += buffer[i] * buffer[i + bestOffset - 1];
        y2 += buffer[i] * buffer[i + bestOffset];
        y3 += buffer[i] * buffer[i + bestOffset + 1];
      }
      
      const a = (y1 + y3 - 2 * y2) / 2;
      const b = (y3 - y1) / 2;
      
      if (a !== 0) {
        const adjustedOffset = bestOffset - b / (2 * a);
        const pitch = sampleRate / adjustedOffset;
        
        if (pitch >= 27.5 && pitch <= 4186) {
          return pitch;
        }
      }
    }
    
    const pitch = sampleRate / bestOffset;
    if (pitch >= 27.5 && pitch <= 4186) {
      return pitch;
    }
  }
  
  return -1;
}

export default function PitchDetector() {
  const [note, setNote] = useState('--');
  const [frequency, setFrequency] = useState(0);
  const [rms, setRMS] = useState(0);
  const [isActive, setIsActive] = useState(false);
  const [gain, setGain] = useState(5);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  const handleGainChange = (newGain: number) => {
    setGain(newGain);
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = newGain;
    }
  };

  const toggleListening = useCallback(async () => {
    if (isActive) {
      setIsActive(false);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      return;
    }

    try {
      console.log('Requesting mic...');
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 44100,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      streamRef.current = stream;

      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContext();
      
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      
      console.log('AudioContext sampleRate:', audioContext.sampleRate);
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 4096; // Larger FFT for better low-frequency resolution
      analyser.smoothingTimeConstant = 0; // No smoothing - we'll handle this ourselves
      analyser.minDecibels = -100;
      analyser.maxDecibels = -10;

      // Add gain node to amplify the signal
      const gainNode = audioContext.createGain();
      gainNode.gain.value = gain; // Use current gain value
      gainNodeRef.current = gainNode;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(gainNode);
      gainNode.connect(analyser);
      analyserRef.current = analyser;

      // Smoothing for note display
      let lastNote = '--';
      let noteConfidence = 0;
      const CONFIDENCE_THRESHOLD = 3; // Need 3 consecutive detections

      const detectPitch = () => {
        if (!analyserRef.current || !audioContextRef.current) return;

        const bufferLength = analyserRef.current.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        analyserRef.current.getFloatTimeDomainData(dataArray);
        
        let rmsValue = 0;
        for (let i = 0; i < bufferLength; i++) {
          rmsValue += dataArray[i] * dataArray[i];
        }
        rmsValue = Math.sqrt(rmsValue / bufferLength);
        setRMS(Number(rmsValue.toFixed(4)));

        const pitch = autoCorrelate(dataArray, audioContextRef.current.sampleRate);
        
        if (pitch > 0) {
          const noteName = frequencyToNoteName(pitch);
          
          // Stability check - require consistent detection
          if (noteName === lastNote) {
            noteConfidence++;
          } else {
            noteConfidence = 1;
            lastNote = noteName;
          }
          
          // Only update display if we have confidence
          if (noteConfidence >= CONFIDENCE_THRESHOLD) {
            setNote(noteName);
            setFrequency(Math.round(pitch * 10) / 10);
            console.log(`Detected: ${noteName} at ${pitch.toFixed(1)} Hz`);
          }
        } else {
          // Decay confidence when no signal
          noteConfidence = Math.max(0, noteConfidence - 1);
          if (noteConfidence === 0) {
            setNote('--');
            setFrequency(0);
            lastNote = '--';
          }
        }

        animationRef.current = requestAnimationFrame(detectPitch);
      };

      setIsActive(true);
      requestAnimationFrame(detectPitch);
      
    } catch (err: any) {
      console.error('Mic error:', err);
      alert(`Mic failed: ${err.message}`);
    }
  }, [isActive, gain]);

  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #9333ea 0%, #3b82f6 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
    }}>
      <div style={{
        background: 'rgba(255,255,255,0.1)',
        backdropFilter: 'blur(20px)',
        borderRadius: '24px',
        padding: '3rem',
        boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
        maxWidth: '400px',
        width: '100%',
        textAlign: 'center',
        border: '1px solid rgba(255,255,255,0.2)'
      }}>
        <h1 style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'white', marginBottom: '2rem' }}>
          🎹 Piano Note Detector
        </h1>
        
        <div style={{
          background: 'rgba(0,0,0,0.3)',
          borderRadius: '16px',
          padding: '2rem',
          backdropFilter: 'blur(10px)'
        }}>
          <div style={{
            fontSize: '4rem',
            fontFamily: 'monospace',
            marginBottom: '1rem',
            letterSpacing: '0.1em',
            color: frequency > 0 ? '#10b981' : 'white',
            fontWeight: 'bold'
          }}>
            {note}
          </div>
          <div style={{ fontSize: '1.25rem', color: 'rgba(255,255,255,0.8)' }}>
            {frequency ? `${frequency} Hz` : 'No signal'}
          </div>
          <div style={{ 
            fontSize: '0.9rem', 
            color: rms > 0.002 ? '#10b981' : '#fbbf24',
            marginTop: '0.5rem',
            fontFamily: 'monospace',
            fontWeight: 'bold'
          }}>
            Volume: {(rms * 100).toFixed(1)}% {rms > 0.002 ? '🟢' : '🟡'}
          </div>
        </div>
        
        <div style={{
          marginTop: '1.5rem',
          padding: '1rem',
          background: 'rgba(0,0,0,0.2)',
          borderRadius: '12px'
        }}>
          <label style={{
            display: 'block',
            color: 'white',
            marginBottom: '0.5rem',
            fontSize: '0.9rem',
            fontWeight: 'bold'
          }}>
            Amplification: {gain}x
          </label>
          <input
            type="range"
            min="1"
            max="20"
            step="0.5"
            value={gain}
            onChange={(e) => handleGainChange(parseFloat(e.target.value))}
            disabled={!isActive}
            style={{
              width: '100%',
              cursor: isActive ? 'pointer' : 'not-allowed',
              accentColor: '#10b981'
            }}
          />
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '0.7rem',
            color: 'rgba(255,255,255,0.6)',
            marginTop: '0.25rem'
          }}>
            <span>Quiet</span>
            <span>LOUD</span>
          </div>
        </div>
        
        <button
          onClick={toggleListening}
          style={{
            width: '100%',
            padding: '1.5rem',
            marginTop: '2rem',
            borderRadius: '16px',
            fontWeight: 'bold',
            fontSize: '1.125rem',
            border: 'none',
            cursor: 'pointer',
            background: isActive ? '#ef4444' : '#10b981',
            color: 'white',
            boxShadow: isActive ? '0 10px 25px rgba(239,68,68,0.4)' : '0 10px 25px rgba(16,185,129,0.4)',
            transition: 'all 0.2s'
          }}
        >
          {isActive ? '🛑 Stop Listening' : '🎤 Start Listening'}
        </button>
        
        <div style={{
          color: 'rgba(255,255,255,0.7)',
          fontSize: '0.85rem',
          marginTop: '1.5rem',
          lineHeight: '1.5',
          textAlign: 'left'
        }}>
          <p style={{ marginBottom: '0.5rem' }}><strong>Tips for best results:</strong></p>
          <p>🎹 Play single notes clearly</p>
          <p>🎤 Position mic close to piano</p>
          <p>🔇 Minimize background noise</p>
          <p>📊 Check F12 console for debug info</p>
          <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', opacity: 0.8 }}>
            Range: A0 (27.5 Hz) to C8 (4186 Hz)
          </p>
        </div>
      </div>
    </div>
  );
}