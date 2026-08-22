export interface RunningTimer {
  end(label?: string): number;
}

export function startTimer(): RunningTimer {
  const start = performance.now();
  return {
    end(_label?: string): number {
      return performance.now() - start;
    },
  };
}
