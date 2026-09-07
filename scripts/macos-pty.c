// Small bundled PTY host. No Python, shell interpolation or system Node needed.
#include <util.h>
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>
#include <stdio.h>
#include <poll.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
static pid_t shell_pid = -1;
static void stop(int signal_number) { (void)signal_number; if(shell_pid>0)kill(-shell_pid,SIGHUP); _exit(0); }
static int write_all(int fd,const char *bytes,ssize_t length){while(length>0){ssize_t count=write(fd,bytes,(size_t)length);if(count<=0)return -1;bytes+=count;length-=count;}return 0;}
int main(void){
 int master;struct winsize size={.ws_row=40,.ws_col=100};shell_pid=forkpty(&master,NULL,NULL,&size);
 if(shell_pid<0){perror("forkpty");return 1;}
 if(shell_pid==0){execl("/bin/zsh","zsh","-il",NULL);perror("zsh");_exit(127);}
 signal(SIGTERM,stop);signal(SIGHUP,stop);signal(SIGINT,stop);
 struct pollfd fds[3]={{.fd=STDIN_FILENO,.events=POLLIN},{.fd=master,.events=POLLIN},{.fd=3,.events=POLLIN}};char buffer[8192];
 while(poll(fds,3,-1)>0){
  if(fds[2].revents&POLLIN){char dimensions[64];ssize_t n=read(3,dimensions,63);if(n>0){dimensions[n]=0;int cols,rows;if(sscanf(dimensions,"%d %d",&cols,&rows)==2&&cols>=10&&cols<=500&&rows>=2&&rows<=300){struct winsize next={.ws_col=cols,.ws_row=rows};ioctl(master,TIOCSWINSZ,&next);}}}
  if(fds[0].revents&POLLIN){ssize_t n=read(STDIN_FILENO,buffer,sizeof(buffer));if(n<=0)break;if(write_all(master,buffer,n)<0)break;}
  if(fds[1].revents&POLLIN){ssize_t n=read(master,buffer,sizeof(buffer));if(n<=0)break;if(write_all(STDOUT_FILENO,buffer,n)<0)break;}
  if(fds[0].revents&(POLLHUP|POLLERR)||fds[1].revents&(POLLHUP|POLLERR))break;
 }
 close(master);kill(-shell_pid,SIGHUP);int status=0;waitpid(shell_pid,&status,0);return WIFEXITED(status)?WEXITSTATUS(status):0;
}
