#!/bin/bash
#
#<UDF name="ssuser" Label="Sudo user username?" example="username" />
#<UDF name="sspassword" Label="Sudo user password?" example="strongPassword" />
#<UDF name="sspubkey" Label="SSH pubkey (installed for root and sudo user)?" example="ssh-rsa ..." />
#
# Works for CentOS 7

# Inspired by: https://raw.githubusercontent.com/mb243/linux-deployment-scripts/master/hardened-CentOS7.sh

# AS root     *******************************************

if [[ ! $SSUSER ]]; then read -p "Sudo user username?" SSUSER; fi
if [[ ! $SSPASSWORD ]]; then read -p "Sudo user password?" SSPASSWORD; fi
if [[ ! $SSPUBKEY ]]; then read -p "SSH pubkey (installed for root and sudo user)?" SSPUBKEY; fi

# set up sudo user
echo "Setting sudo user: $SSUSER..."
useradd $SSUSER
usermod -aG wheel $SSUSER
echo "...done"
# sudo user complete

# set up ssh pubkey
# for x in... loop doesn't work here, sadly
echo "Setting up ssh pubkeys..."
mkdir -p /root/.ssh
mkdir -p /home/$SSUSER/.ssh
echo "$SSPUBKEY" >> /root/.ssh/authorized_keys
echo "$SSPUBKEY" >> /home/$SSUSER/.ssh/authorized_keys
chmod -R 700 /root/.ssh
chmod -R 700 /home/${SSUSER}/.ssh
chown -R ${SSUSER}:${SSUSER} /home/${SSUSER}/.ssh
echo "...done"

# disable password and root over ssh
echo "Disabling passwords and root login over ssh..."
sed -i -e "s/PermitRootLogin yes/PermitRootLogin no/" /etc/ssh/sshd_config
sed -i -e "s/#PermitRootLogin no/PermitRootLogin no/" /etc/ssh/sshd_config
sed -i -e "s/PasswordAuthentication yes/PasswordAuthentication no/" /etc/ssh/sshd_config
sed -i -e "s/#PasswordAuthentication no/PasswordAuthentication no/" /etc/ssh/sshd_config
echo "Restarting sshd..."
systemctl restart sshd
echo "...done"

#remove unneeded services
echo "Removing unneeded services..."
yum remove -y avahi chrony
echo "...done"

# Initial needfuls
yum update -y
yum install -y epel-release
yum update -y

# Set up automatic  updates
echo "Setting up automatic updates..."
yum install -y yum-cron
sed -i -e "s/apply_updates = no/apply_updates = yes/" /etc/yum/yum-cron.conf
echo "...done"
# auto-updates complete

# set up fail2ban
echo "Setting up fail2ban..."
yum install -y fail2ban
cd /etc/fail2ban
cp fail2ban.conf fail2ban.local
cp jail.conf jail.local
sed -i -e "s/backend = auto/backend = systemd/" /etc/fail2ban/jail.local
systemctl enable fail2ban
systemctl start fail2ban
echo "...done"

# set up firewalld
# https://basildoncoder.com/blog/logging-connections-with-firewalld.html
# https://www.computernetworkingnotes.com/rhce-study-guide/firewalld-rich-rules-explained-with-examples.html
# https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/7/html/security_guide/configuring_complex_firewall_rules_with_the_rich-language_syntax
echo "Setting up firewalld..."
systemctl start firewalld
systemctl enable firewalld
firewall-cmd --set-default-zone=public
firewall-cmd --zone=public --add-interface=eth0
firewall-cmd --permanent --zone=public --remove-service=ssh
firewall-cmd --permanent --zone=public --add-rich-rule="rule family=\"ipv4\" service name=\"ssh\" log limit value=\"10/h\" level=\"info\" accept"
firewall-cmd --permanent --zone=public --add-service=http
firewall-cmd --permanent --zone=public --add-service=https
firewall-cmd --reload
echo "...done"

# Set up distro kernel and grub
yum install -y kernel grub2
sed -i -e "s/GRUB_TIMEOUT=5/GRUB_TIMEOUT=10/" /etc/default/grub
sed -i -e "s/crashkernel=auto rhgb console=ttyS0,19200n8/console=ttyS0,19200n8/" /etc/default/grub
mkdir /boot/grub
grub2-mkconfig -o /boot/grub/grub.cfg

# ensure ntp is installed and running
yum install -y ntp
systemctl enable ntpd
systemctl start ntpd

# Configure Groups
echo "Adding groups and users..."
groupadd admin
groupadd dev

adduser actions && passwd actions
usermod -aG dev actions

mkdir -p /srv/actions/app
chown -R actions:dev /srv/actions
chmod -R g+ws actions
eco "...done"

# Configure SELinux
echo "Configuring SELinux..."
yum install -y policycoreutils policycoreutils-python selinux-policy selinux-policy-targeted libselinux-utils setools setools-console
echo "...done"


# AS non-root account ************************************
set -m
sudo -i -u actions /bin/bash - << EOF
echo "Switching to actions user..."
su actions

# Install git
echo "Installing git..."
sudo yum -y install git asciidoc xmlto docbook2X
sudo yum -y install gcc curl-devel expat-devel gettext-devel openssl-devel zlib-devel perl-ExtUtils-MakeMaker

git clone https://github.com/git/git
cd git
make -i prefix=/usr all doc info
sudo make -i prefix=/usr install install-doc install-html install-info
cd .. && rm -rf git


# Install Docker
echo "Installing docker..."
sudo yum install -y yum-utils device-mapper-persistent-data lvm2
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo yum-config-manager --enable docker-ce-edge
sudo yum-config-manager --enable docker-ce-test

sudo yum -y install docker-ce python-pip
sudo pip install --upgrade pip
sudo pip install docker-compose

sudo systemctl start docker
sudo gpasswd -M kabir,sasquatch docker
echo "...done"

# (need to exit to acquire docker group membership)
exit

# Confirm docker works
echo "Checking if docker works..."
docker run hello-world
docker run --name docker-nginx -p 80:80 -d nginx
curl localhost

# Set up https://github.com/nginx-proxy/docker-letsencrypt-nginx-proxy-companion/
echo "Setting up host's nginx-proxy..."
mkdir -p /srv/actions/nginx-proxy
cd /srv/actions/nginx-proxy
echo "
version: '3.7'

services:
  nginx-proxy:
    container_name: nginx-proxy
    image: jwilder/nginx-proxy
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - conf:/etc/nginx/conf.d
      - vhost:/etc/nginx/vhost.d
      - html:/usr/share/nginx/html
      - dhparam:/etc/nginx/dhparam
      - certs:/etc/nginx/certs:ro
      - /var/run/docker.sock:/tmp/docker.sock:ro

  letsencrypt:
    container_name: nginx-proxy-le
    image: jrcs/letsencrypt-nginx-proxy-companion
    volumes:
      - certs:/etc/nginx/certs:rw
      - vhost:/etc/nginx/vhost.d
      - html:/usr/share/nginx/html
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - NGINX_PROXY_CONTAINER=nginx-proxy

volumes:
  conf:
  vhost:
  html:
  dhparam:
  certs:

networks:
  default:
    name: nginx-proxy
" >> docker-compose.yml

docker-compose up -d 
sleep 30
docker-compose logs
EOF

echo "Setting $SSUSER password $SSPASSWORD..."
echo $SSPASSWORD | passwd $SSUSER --stdin

echo "All finished! Rebooting..."
(sleep 5; reboot) &
