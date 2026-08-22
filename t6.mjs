const m = await import("/home/cvsz/zaff/packages/events/dist/redis-streams.js");
console.log("dyn import ok", typeof m.RedisStreamsEventBus);
process.exit(0);
