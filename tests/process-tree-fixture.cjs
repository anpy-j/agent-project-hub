const {spawn}=require('node:child_process');
const net=require('node:net');
if(process.argv[2]==='parent') {
  const child=spawn(process.execPath,[__filename,'server'],{stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  setInterval(()=>{},1000);
} else {
  const server=net.createServer(socket=>socket.end('alive'));
  server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:server.address().port})));
}
