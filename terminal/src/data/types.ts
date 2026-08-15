export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export interface CandleBar {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SwingPoint {
  bar: number;
  price: number;
  type: "H" | "HH" | "LH" | "L" | "LL" | "HL";
  kind: "high" | "low";
}

export interface BosEvent {
  barStart: number;
  barEnd: number;
  price: number;
  direction: "bull" | "bear";
  kind: "bos" | "choch";
}

export interface FvgEvent {
  bar: number;
  top: number;
  bottom: number;
  direction: "bull" | "bear";
}

export interface OrderBlock {
  bar: number;
  barEnd: number;
  top: number;
  bottom: number;
  direction: "bull" | "bear";
}

export interface VolumeImbalanceEvent {
  bar: number;
  top: number;
  bottom: number;
  direction: "bull" | "bear";
}

export interface LiquidityEvent {
  barStart: number;
  barEnd: number;
  price: number;
  direction: "sell_side" | "buy_side";
}

export interface Trade {
  dir: "long" | "short";
  entryBar: number;
  entryPrice: number;
  sl: number;
  tp: number;
  exitBar: number;
  result: "Win" | "Lose";
  r: number;
  setup: string;
}

export interface SetupStat {
  n: number;
  wr: number;
  exp: number;
}

export interface BacktestStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancy: number;
  rr: number;
  breakevenWr: number;
  bySetup: Record<string, SetupStat>;
}

export interface SymbolTimeframeData {
  symbol: string;
  timeframe: Timeframe;
  bars: CandleBar[];
  swingPoints: SwingPoint[];
  bosEvents: BosEvent[];
  fvgEvents: FvgEvent[];
  orderBlocks: OrderBlock[];
  volumeImbalanceEvents: VolumeImbalanceEvent[];
  liquidityEvents: LiquidityEvent[];
  trades: Trade[];
  stats: BacktestStats | null;
}
