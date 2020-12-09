#!/bin/bash

#<UDF name="admin_users_json" Label="JSON array for authorized users" example="[{'username':'name', 'ssh_public_key':'public key' }]" />
#<UDF name="actions_user" Label="Deploy actions username" example="actions" />
#<UDF name="actions_key" Label="Deploy actions public ssh key" example="actions" />

# Works for CentOS 7
# Inspired by: https://raw.githubusercontent.com/mb243/linux-deployment-scripts/master/hardened-CentOS7.sh

# AS root *******************************************

if [[ ! $ADMIN_USERS_JSON ]]; then read -p "JSON array for authorized users, eg [{'username':'name', 'ssh_public_key':'public key' }]: " ADMIN_USERS_JSON; fi
if [[ ! $ACTIONS_USER ]]; then read -p "Username for deploy actions user?: " ACTIONS_USER; fi
if [[ ! $ACTIONS_KEY ]]; then read -p "Public ssh key for deploy actions user?: " ACTIONS_KEY; fi

# Initial needfuls
yum update -y
yum install -y epel-release
yum update -y

# Install jq
sudo yum -y install https://dl.fedoraproject.org/pub/epel/epel-release-latest-7.noarch.rpm
sudo yum -y install jq

# Configure Groups
echo "Creating admin and dev groups..."
groupadd admin
groupadd dev

# Configure Users
ADMIN_USERNAMES=""
for row in $(echo $ADMIN_USERS_JSON | jq -r '.[] | @base64'); do
  _jq() {
   echo ${row} | base64 --decode | jq -r ${1}
  }
  username=$(_jq '.username')
  password=$(_jq '.username')
  ssh_public_key=$(_jq '.ssh_public_key')
  echo "Creating admin user: $username..."
  ADMIN_USERNAMES="$username,$ADMIN_USERNAMES"
  useradd $username && echo $password | passwd $password --stdin
  usermod -aG admin,dev,wheel $username
  mkdir -p /home/$user/.ssh
  echo "$ssh_public_key" >> /home/$user/.ssh/authorized_keys
  chmod -R 700 /home/$user/.ssh 
  chown -R $user:$user /home/$user/.ssh
done

echo "Creating actions user: $ACTIONS_USER"
useradd $ACTIONS_USER && echo $ACTIONS_USER | passwd $ACTIONS_USER --stdin
usermod -aG dev $ACTIONS_USER
mkdir -p /home/$ACTIONS_USER/.ssh
echo "$ACTIONS_KEY" >> /home/$ACTIONS_USER/.ssh/authorized_keys
chmod -R 700 /home/$ACTIONS_USER/.ssh 
chown -R $ACTIONS_USER:$ACTIONS_USER /home/$ACTIONS_USER/.ssh

ACTIONS_DIR="/srv/$ACTIONS_USER"

mkdir -p $ACTIONS_DIR
chown -R $ACTIONS_USER:dev $ACTIONS_DIR
chmod -R g+ws $ACTIONS_DIR

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

# Set up automatic  updates
echo "Setting up automatic updates..."
yum install -y yum-cron
sed -i -e "s/apply_updates = no/apply_updates = yes/" /etc/yum/yum-cron.conf
echo "...done"

# Set up fail2ban
echo "Setting up fail2ban..."
yum install -y fail2ban
cd /etc/fail2ban
cp fail2ban.conf fail2ban.local
cp jail.conf jail.local
sed -i -e "s/backend = auto/backend = systemd/" /etc/fail2ban/jail.local
systemctl enable fail2ban
systemctl start fail2ban
echo "...done"

# Set up firewalld
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

# Configure SELinux
echo "Configuring SELinux..."
yum install -y policycoreutils policycoreutils-python selinux-policy selinux-policy-targeted libselinux-utils setools setools-console
echo "...done"

# Install git
# echo "Installing git from source..."
# sudo yum -y install git asciidoc xmlto docbook2X
# sudo yum -y install gcc curl-devel expat-devel gettext-devel openssl-devel zlib-devel perl-ExtUtils-MakeMaker

# git clone https://github.com/git/git
# cd git
# make -i prefix=/usr all doc info
# sudo make -i prefix=/usr install install-doc install-html install-info
# cd .. && rm -rf git

# Install Docker
echo "Installing docker..."
yum update -y
yum install -y git yum-utils device-mapper-persistent-data lvm2 httpd-tools python3
yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
yum install -y docker-ce docker-ce-cli containerd.io
curl -4 -o get-pip.py -L https://bootstrap.pypa.io/get-pip.py
python3 get-pip.py && rm -f $PWD/get-pip.py 
pip3 install docker-compose
systemctl start docker && systemctl enable docker
gpasswd -M $ADMIN_USERNAMES,$ACTIONS_USER docker
echo "...done"


# AS actions user ************************************

# Set up https://github.com/nginx-proxy/docker-letsencrypt-nginx-proxy-companion/
sudo -i -u $ACTIONS_USER /bin/bash - << EOF
  echo "Setting up host's nginx-proxy..."
  mkdir -p $ACTIONS_DIR/nginx-proxy
  cd $ACTIONS_DIR/nginx-proxy
  curl -4 -o docker-compose.yml -L https://raw.githubusercontent.com/sarink-software/actions-deploy-to-linode/main/nginx-proxy-docker-compose.yml
  docker-compose up -d 
  sleep 30
  docker-compose logs
EOF

echo "All finished! Rebooting..."
(sleep 5; reboot) &
