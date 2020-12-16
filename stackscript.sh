#<UDF name="admin_users_json" Label="JSON array for authorized users" example="[{'user':'name', 'public_key':'ssh-rsa ABC123...' }]" />
#<UDF name="deploy_user" Label="Deploy user" example="deploy" />
#<UDF name="deploy_user_public_key" Label="Public SSH key for deploy user" example="ssh-rsa ABC123..." />

# Works for CentOS 7
# Inspired by: https://raw.githubusercontent.com/mb243/linux-deployment-scripts/master/hardened-CentOS7.sh

# AS root *******************************************

if [[ ! $ADMIN_USERS_JSON ]]; then read -p "JSON array for authorized users, eg [{'user':'name', 'public_key':'ssh-rsa ABC123...' }]: " ADMIN_USERS_JSON; fi
if [[ ! $DEPLOY_USER ]]; then read -p "Deploy user?: " DEPLOY_USER; fi
if [[ ! $DEPLOY_USER_PUBLIC_KEY ]]; then read -p "Public SSH key for deploy user?: " DEPLOY_USER_PUBLIC_KEY; fi

# Install needfuls
yum update -y
yum install -y epel-release tree vim
yum update -y

# Install jq for parsing admin users json
sudo yum -y install https://dl.fedoraproject.org/pub/epel/epel-release-latest-7.noarch.rpm
sudo yum -y install jq

# Configure Groups
echo "Creating admin and dev groups..."
groupadd admin
groupadd dev

create_user() {
  username=$1
  password=$2
  ssh_public_key=$3
  useradd $username && echo $password | passwd $password --stdin
  mkdir -p /home/$username/.ssh
  echo "$ssh_public_key" >> /home/$username/.ssh/authorized_keys
  chmod -R 700 /home/$username/.ssh 
  chown -R $username:$username /home/$username
  chown -R $username:$username /home/$username/.ssh
  chmod 644 /home/$username/.ssh/authorized_keys
}

# Configure Users
ADMIN_USERNAMES=""
for row in $(echo $ADMIN_USERS_JSON | jq -r '.[] | @base64'); do
  _jq() {
   echo ${row} | base64 --decode | jq -r ${1}
  }
  username=$(_jq '.user')
  password=$(_jq '.user')
  ssh_public_key=$(_jq '.public_key')
  ADMIN_USERNAMES="$username,$ADMIN_USERNAMES"
  echo "Creating admin user: $username..."
  create_user $username $password "$ssh_public_key"
  usermod -aG admin,dev,wheel $username
done

echo "Creating deploy user: $DEPLOY_USER..."
create_user $DEPLOY_USER $DEPLOY_USER "$DEPLOY_USER_PUBLIC_KEY"
usermod -aG dev $DEPLOY_USER

DEPLOY_DIR="/srv/deploy"

mkdir -p $DEPLOY_DIR
chown -R $DEPLOY_USER:dev $DEPLOY_DIR
chmod -R g+ws $DEPLOY_DIR

# Disable password and root over ssh
echo "Disabling passwords and root login over ssh..."
sed -i -e "s/PermitRootLogin yes/PermitRootLogin no/" /etc/ssh/sshd_config
sed -i -e "s/#PermitRootLogin no/PermitRootLogin no/" /etc/ssh/sshd_config
sed -i -e "s/PasswordAuthentication yes/PasswordAuthentication no/" /etc/ssh/sshd_config
sed -i -e "s/#PasswordAuthentication no/PasswordAuthentication no/" /etc/ssh/sshd_config
echo "Restarting sshd..."
systemctl restart sshd
echo "...done"

# Remove unneeded services
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
# pip3 install docker-compose
sudo curl -4 -L "https://github.com/docker/compose/releases/download/1.27.4/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
sudo ln -s /usr/local/bin/docker-compose /usr/bin/docker-compose
systemctl start docker && systemctl enable docker
gpasswd -M "$ADMIN_USERNAMES$DEPLOY_USER" docker
docker-compose --version
echo "...done"


# AS actions user ************************************

# Set up https://github.com/nginx-proxy/docker-letsencrypt-nginx-proxy-companion/
sudo -i -u $DEPLOY_USER /bin/bash - << EOF
  echo "Setting up host's nginx-proxy..."
  mkdir -p $DEPLOY_DIR/nginx-proxy
  cd $DEPLOY_DIR/nginx-proxy
  curl -4 -o docker-compose.yml -L https://raw.githubusercontent.com/sarink-software/actions-deploy-to-linode/main/nginx-proxy-docker-compose.yml
  docker-compose up -d 
  sleep 40
  docker-compose logs
EOF

exit 0
